/**
 * maintenance.js — Maintenance page logic for MODE-S Wind.
 *
 * All API calls include username + password in the JSON body.
 * Credentials are stored only in JS variables (cleared on page reload).
 * No server-side session is maintained.
 */

'use strict';

let _user = '';
let _pass = '';
let _unlocked = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _api(endpoint, extra = {}) {
  const body = { username: _user, password: _pass, ...extra };
  const r = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (r.status === 401) throw new Error('Unauthorized');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function _setStatus(id, msg, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'maint-op-status ' + (isError ? 'maint-status-error' : 'maint-status-ok');
}

function _fmt(n) {
  return n != null ? Number(n).toLocaleString() : '—';
}

// ── Stats ────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const d = await _api('/api/maintenance/stats');

    function _fill(rowId, stat) {
      const row = document.getElementById(rowId);
      if (!row) return;
      const cells = row.querySelectorAll('span');
      if (cells.length >= 4) {
        cells[1].textContent = _fmt(stat.rows);
        cells[2].textContent = stat.oldest || '—';
        cells[3].textContent = stat.newest || '—';
      }
    }

    _fill('stat-observations', d.observations);
    _fill('stat-flights',      d.flights);
    _fill('stat-approach',     d.approach_history);
    _fill('stat-gps',          d.gps_quality_hours);
    _fill('stat-gpsz',         d.gps_quality_zone_hours);
    const sizeEl = document.getElementById('stat-dbsize-val');
    if (sizeEl) sizeEl.textContent = d.db_size_mb != null ? `${d.db_size_mb} MB` : '—';
  } catch (e) {
    console.warn('Stats load failed:', e.message);
  }
}

// ── Autopurge ─────────────────────────────────────────────────────────────────

async function loadAutopurgeConfig() {
  try {
    const d = await _api('/api/maintenance/flight/autopurge-config');
    document.getElementById('autopurge-enable').value = d.enabled ? '1' : '0';
    document.getElementById('autopurge-days').value   = d.days || 30;
  } catch (_) {}
}

document.getElementById('autopurge-save-btn').addEventListener('click', async () => {
  const enabled = document.getElementById('autopurge-enable').value === '1';
  const days    = parseInt(document.getElementById('autopurge-days').value, 10) || 30;
  try {
    await _api('/api/maintenance/flight/autopurge', { enabled, days });
    _setStatus('autopurge-status', `Saved — autopurge ${enabled ? 'enabled' : 'disabled'}, threshold ${days} days`);
  } catch (e) {
    _setStatus('autopurge-status', `Error: ${e.message}`, true);
  }
});

// ── Flight / Meteo purge ──────────────────────────────────────────────────────

let _flightPreviewOk = false;

document.getElementById('flight-preview-btn').addEventListener('click', async () => {
  _flightPreviewOk = false;
  document.getElementById('flight-purge-btn').disabled = true;
  document.getElementById('flight-preview-result').textContent = 'Loading…';
  document.getElementById('flight-purge-result').textContent = '';
  const days = parseInt(document.getElementById('flight-days').value, 10) || 30;
  try {
    const d = await _api('/api/maintenance/flight/preview', { days });
    const msg = `Will delete: ${_fmt(d.observations)} observations, ${_fmt(d.flights)} flights`
      + (d.range_oldest ? ` · from ${d.range_oldest} to ${d.range_newest}` : ' (none)')
      + ` · cutoff: ${d.cutoff_date}`;
    document.getElementById('flight-preview-result').textContent = msg;
    if (d.observations > 0 || d.flights > 0) {
      _flightPreviewOk = true;
      document.getElementById('flight-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('flight-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('flight-purge-btn').addEventListener('click', async () => {
  if (!_flightPreviewOk) return;
  if (!confirm('Permanently delete the previewed flight and observation records?')) return;
  document.getElementById('flight-purge-btn').disabled = true;
  _flightPreviewOk = false;
  const days = parseInt(document.getElementById('flight-days').value, 10) || 30;
  try {
    const d = await _api('/api/maintenance/flight/purge', { days });
    _setStatus('flight-purge-result',
      `Deleted: ${_fmt(d.observations_deleted)} observations, ${_fmt(d.flights_deleted)} flights`);
    document.getElementById('flight-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('flight-purge-result', `Error: ${e.message}`, true);
  }
});

// ── GPS quality purge ─────────────────────────────────────────────────────────

let _gpsPreviewOk = false;

document.getElementById('gps-preview-btn').addEventListener('click', async () => {
  _gpsPreviewOk = false;
  document.getElementById('gps-purge-btn').disabled = true;
  document.getElementById('gps-preview-result').textContent = 'Loading…';
  document.getElementById('gps-purge-result').textContent = '';
  const days = parseInt(document.getElementById('gps-days').value, 10) || 90;
  try {
    const d = await _api('/api/maintenance/gps/preview', { days });
    const msg = `Will delete: ${_fmt(d.gps_quality_hours)} hourly rows, `
      + `${_fmt(d.gps_quality_zone_hours)} zone rows · cutoff: ${d.cutoff_date}`;
    document.getElementById('gps-preview-result').textContent = msg;
    if (d.gps_quality_hours > 0 || d.gps_quality_zone_hours > 0) {
      _gpsPreviewOk = true;
      document.getElementById('gps-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('gps-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('gps-purge-btn').addEventListener('click', async () => {
  if (!_gpsPreviewOk) return;
  if (!confirm('Permanently delete the previewed GPS quality records?')) return;
  document.getElementById('gps-purge-btn').disabled = true;
  _gpsPreviewOk = false;
  const days = parseInt(document.getElementById('gps-days').value, 10) || 90;
  try {
    const d = await _api('/api/maintenance/gps/purge', { days });
    _setStatus('gps-purge-result',
      `Deleted: ${_fmt(d.gps_quality_hours_deleted)} hourly rows, ${_fmt(d.gps_quality_zone_hours_deleted)} zone rows`);
    document.getElementById('gps-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('gps-purge-result', `Error: ${e.message}`, true);
  }
});

// ── Unlock ────────────────────────────────────────────────────────────────────

document.getElementById('maint-unlock-btn').addEventListener('click', async () => {
  _user = document.getElementById('maint-user').value;
  _pass = document.getElementById('maint-pass').value;
  const statusEl = document.getElementById('maint-auth-status');
  statusEl.textContent = 'Checking…';
  try {
    await _api('/api/maintenance/stats');
    // If we get here, credentials are valid
    _unlocked = true;
    document.getElementById('maint-body').classList.remove('maint-locked');
    statusEl.textContent = '✓ Unlocked';
    statusEl.className = 'maint-auth-status maint-status-ok';
    await loadStats();
    await loadAutopurgeConfig();
  } catch (e) {
    _unlocked = false;
    _user = _pass = '';
    document.getElementById('maint-body').classList.add('maint-locked');
    statusEl.textContent = e.message === 'Unauthorized' ? '✗ Wrong credentials' : `✗ ${e.message}`;
    statusEl.className = 'maint-auth-status maint-status-error';
  }
});

document.getElementById('maint-refresh-btn').addEventListener('click', loadStats);

// Allow Enter key in credential fields
['maint-user', 'maint-pass'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('maint-unlock-btn').click();
  });
});
