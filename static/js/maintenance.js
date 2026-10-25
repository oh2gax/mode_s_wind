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
      if (cells.length >= 5) {
        cells[1].textContent = _fmt(stat.rows);
        cells[2].textContent = stat.days != null ? stat.days : '—';
        cells[3].textContent = stat.oldest || '—';
        cells[4].textContent = stat.newest || '—';
      }
    }

    _fill('stat-observations', d.observations);
    _fill('stat-flights',      d.flights);
    _fill('stat-approach',     d.approach_history);
    _fill('stat-gps',          d.gps_quality_hours);
    _fill('stat-gpsz',         d.gps_quality_zone_hours);
    if (d.gps_episodes) _fill('stat-episodes', d.gps_episodes);
    if (d.approach_series) _fill('stat-apseries', d.approach_series);
    if (d.profile_hours)   _fill('stat-profile',  d.profile_hours);
    if (d.kinematics_hours) _fill('stat-kinh', d.kinematics_hours);
    if (d.gnss_hours) _fill('stat-gnssh', d.gnss_hours);
    if (d.departure_profiles) _fill('stat-depprof', d.departure_profiles);
    if (d.height_series) _fill('stat-hseries', d.height_series);
    if (d.msg_stats_hours) _fill('stat-msgstats', d.msg_stats_hours);
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
    document.getElementById('archive-enable').value   = d.archive ? '1' : '0';
  } catch (_) {}
}

// ── Archive files and snapshots ──────────────────────────────────────────────

function _utc(ts) {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

let _snapTimer = null;
async function loadArchives() {
  try {
    const d = await _api('/api/maintenance/archive/list');
    const s = d.status || {};
    document.getElementById('archive-dir').textContent  = `Folder: ${s.dir || '—'}`;
    document.getElementById('archive-free').textContent = s.free_mb != null ? `· ${_fmt(s.free_mb)} MB free` : '';
    document.getElementById('archive-error').textContent = s.last_error ? `Last archive error: ${s.last_error}` : '';
    const list = document.getElementById('archive-list');
    const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    list.innerHTML = (d.files || []).length ? '' :
      '<div class="maint-stat-row maint-arc-row"><span>No archive files yet</span></div>';
    for (const f of d.files || []) {
      const row = document.createElement('div');
      row.className = 'maint-stat-row maint-arc-row';
      const extra = [f.approach_series ? `${_fmt(f.approach_series)} appr. series` : '',
                     f.departure_profiles ? `${_fmt(f.departure_profiles)} dep. profiles` : '',
                     f.height_series ? `${_fmt(f.height_series)} height series` : '']
                    .filter(Boolean).join(', ');
      row.innerHTML = `<span title="${f.kind}">${esc(f.file)}</span><span>${f.size_mb} MB</span>` +
        `<span>${f.obs_rows != null ? _fmt(f.obs_rows) : '—'}${extra ? ' · ' + esc(extra) : ''}</span>` +
        `<span>${_utc(f.first)}</span><span>${_utc(f.last)}</span>`;
      list.appendChild(row);
    }
    const sn = s.snapshot || {};
    if (sn.running) {
      _setStatus('snapshot-status', `Writing ${sn.file}…`);
      clearTimeout(_snapTimer); _snapTimer = setTimeout(loadArchives, 3000);
    } else if (sn.error) {
      _setStatus('snapshot-status', `Snapshot failed: ${sn.error}`, true);
    } else if (sn.file && sn.finished) {
      _setStatus('snapshot-status', `Snapshot ${sn.file} written (${sn.size_mb} MB)`);
    }
  } catch (e) {
    _setStatus('snapshot-status', `Error: ${e.message}`, true);
  }
}

document.getElementById('archive-refresh-btn').addEventListener('click', loadArchives);
document.getElementById('snapshot-btn').addEventListener('click', async () => {
  if (!confirm('Write a compact copy of the whole database to the archive folder now? ' +
               'This takes a while and needs free space up to the database size.')) return;
  try {
    const d = await _api('/api/maintenance/archive/snapshot');
    if (d.error && !d.running) throw new Error(d.error);
    _setStatus('snapshot-status', `Writing ${d.file}…`);
    clearTimeout(_snapTimer); _snapTimer = setTimeout(loadArchives, 3000);
  } catch (e) {
    _setStatus('snapshot-status', `Error: ${e.message}`, true);
  }
});

document.getElementById('autopurge-save-btn').addEventListener('click', async () => {
  const enabled = document.getElementById('autopurge-enable').value === '1';
  const days    = parseInt(document.getElementById('autopurge-days').value, 10) || 30;
  const archive = document.getElementById('archive-enable').value === '1';
  try {
    await _api('/api/maintenance/flight/autopurge', { enabled, days, archive });
    _setStatus('autopurge-status', `Saved — autopurge ${enabled ? 'enabled' : 'disabled'}, threshold ${days} days, ` +
                                   `archive before purge ${archive ? 'on' : 'off'}`);
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
    if (d.error) throw new Error(d.error);
    _setStatus('flight-purge-result',
      `Deleted: ${_fmt(d.observations_deleted)} observations, ${_fmt(d.flights_deleted)} flights` +
      (d.archived ? ` (archived first: ${_fmt(d.archived.observations)} observations)` : ''));
    loadArchives();
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

// ── Web users (/api/maintenance/users/…) ─────────────────────────────────────

const _USER_KIND = { config: 'built-in (config.py)', maintenance: 'maintenance', user: 'web pages' };
let _editUser = null;

function _esc(t) {
  return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderUsers(d) {
  const list = document.getElementById('users-list');
  document.getElementById('users-file').textContent = d.file || '(no file: MAINTENANCE_AUTH_FILE not set)';
  list.innerHTML = (d.users || []).map(u => {
    const edit = u.kind !== 'config'
      ? `<button class="maint-btn maint-btn-sm" data-act="pw" data-user="${_esc(u.user)}">New password</button>` : '';
    const del = u.kind === 'user'
      ? `<button class="maint-btn maint-btn-sm maint-btn-danger" data-act="rm" data-user="${_esc(u.user)}">Remove</button>` : '';
    return `<div class="maint-stat-row maint-user-row"><span>${_esc(u.user)}</span>` +
      `<span class="maint-user-kind">${_USER_KIND[u.kind] || u.kind}${u.kind === 'maintenance' && u.hashed === false ? ' · password in clear' : ''}</span>` +
      `<span>${u.changed ? _utc(u.changed) : '—'}</span><span class="maint-user-actions">${edit}${del}</span></div>`;
  }).join('');
  if (!d.writable) _setStatus('users-status', 'The folder of the users file is not writable — users cannot be changed.', true);
}

async function loadUsers() {
  try { renderUsers(await _api('/api/maintenance/users/list')); }
  catch (e) { _setStatus('users-status', `Error: ${e.message}`, true); }
}

async function _usersCall(action, target, pw) {
  const r = await fetch(`/api/maintenance/users/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: _user, password: _pass, target, new_password: pw }),
  });
  if (r.status === 401) throw new Error('Unauthorized');
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function _closeEdit() {
  _editUser = null;
  document.getElementById('users-edit-row').style.display = 'none';
  document.getElementById('users-edit-pass').value = document.getElementById('users-edit-pass2').value = '';
}

document.getElementById('users-refresh-btn').addEventListener('click', loadUsers);
document.getElementById('users-list').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const name = b.dataset.user;
  if (b.dataset.act === 'pw') {
    _editUser = name;
    document.getElementById('users-edit-name').textContent = name;
    document.getElementById('users-edit-row').style.display = '';
    document.getElementById('users-edit-pass').focus();
    return;
  }
  if (!confirm(`Remove the user ${name}? They can no longer open the web pages.`)) return;
  try {
    renderUsers(await _usersCall('remove', name));
    _setStatus('users-status', `✓ ${name} removed`);
    if (_editUser === name) _closeEdit();
  } catch (err) { _setStatus('users-status', `Error: ${err.message}`, true); }
});
document.getElementById('users-edit-cancel-btn').addEventListener('click', _closeEdit);
document.getElementById('users-edit-save-btn').addEventListener('click', async () => {
  const p1 = document.getElementById('users-edit-pass').value, p2 = document.getElementById('users-edit-pass2').value;
  if (!_editUser) return;
  if (p1 !== p2) { _setStatus('users-status', 'The passwords do not match.', true); return; }
  try {
    const d = await _usersCall('password', _editUser, p1);
    if (d.kind === 'maintenance' && _editUser === _user) {   // the Maintenance login changed with it
      _pass = p1;
      document.getElementById('maint-pass').value = '';
    }
    renderUsers(d);
    _setStatus('users-status', `✓ New password saved for ${_editUser}` + (d.kind === 'maintenance' ? ' (also the Maintenance login)' : ''));
    _closeEdit();
  } catch (err) { _setStatus('users-status', `Error: ${err.message}`, true); }
});
document.getElementById('users-add-btn').addEventListener('click', async () => {
  const name = document.getElementById('users-add-name').value.trim();
  const p1 = document.getElementById('users-add-pass').value, p2 = document.getElementById('users-add-pass2').value;
  if (!name) { _setStatus('users-status', 'Enter a username.', true); return; }
  if (p1 !== p2) { _setStatus('users-status', 'The passwords do not match.', true); return; }
  try {
    renderUsers(await _usersCall('add', name, p1));
    _setStatus('users-status', `✓ ${name} added`);
    ['users-add-name', 'users-add-pass', 'users-add-pass2'].forEach(id => { document.getElementById(id).value = ''; });
  } catch (err) { _setStatus('users-status', `Error: ${err.message}`, true); }
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
    await loadArchives();
    await loadUsers();
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

// ── Approach history purge (older than N days) ───────────────────────────────

let _approachPreviewOk = false;

document.getElementById('approach-preview-btn').addEventListener('click', async () => {
  _approachPreviewOk = false;
  document.getElementById('approach-purge-btn').disabled = true;
  document.getElementById('approach-preview-result').textContent = 'Loading\u2026';
  document.getElementById('approach-purge-result').textContent = '';
  const days = parseInt(document.getElementById('approach-days').value, 10) || 90;
  try {
    const d = await _api('/api/maintenance/approach/preview', { days });
    const msg = `Will delete: ${_fmt(d.approaches)} approach records`
      + (d.range_oldest ? ` · from ${d.range_oldest} to ${d.range_newest}` : ' (none)')
      + ` · cutoff: ${d.cutoff_date}`;
    document.getElementById('approach-preview-result').textContent = msg;
    if (d.approaches > 0) {
      _approachPreviewOk = true;
      document.getElementById('approach-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('approach-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('approach-purge-btn').addEventListener('click', async () => {
  if (!_approachPreviewOk) return;
  if (!confirm('Permanently delete the previewed approach history records?')) return;
  document.getElementById('approach-purge-btn').disabled = true;
  _approachPreviewOk = false;
  const days = parseInt(document.getElementById('approach-days').value, 10) || 90;
  try {
    const d = await _api('/api/maintenance/approach/purge', { days });
    _setStatus('approach-purge-result', `Deleted: ${_fmt(d.approaches_deleted)} approach records`);
    document.getElementById('approach-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('approach-purge-result', `Error: ${e.message}`, true);
  }
});

// ── Approach history date-range purge ─────────────────────────────────────────

let _approachDatePreviewOk = false;

document.getElementById('approach-date-preview-btn').addEventListener('click', async () => {
  _approachDatePreviewOk = false;
  document.getElementById('approach-date-purge-btn').disabled = true;
  document.getElementById('approach-date-preview-result').textContent = 'Loading\u2026';
  document.getElementById('approach-date-purge-result').textContent = '';
  const date_from = document.getElementById('approach-date-from').value;
  const date_to   = document.getElementById('approach-date-to').value;
  try {
    const d = await _api('/api/maintenance/approach/date-preview', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    const msg = `Will delete: ${_fmt(d.approaches)} approach records · ${d.date_from} to ${d.date_to}`;
    document.getElementById('approach-date-preview-result').textContent = msg;
    if (d.approaches > 0) {
      _approachDatePreviewOk = true;
      document.getElementById('approach-date-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('approach-date-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('approach-date-purge-btn').addEventListener('click', async () => {
  if (!_approachDatePreviewOk) return;
  const date_from = document.getElementById('approach-date-from').value;
  const date_to   = document.getElementById('approach-date-to').value;
  if (!confirm(`Permanently delete approach history records from ${date_from} to ${date_to}?`)) return;
  document.getElementById('approach-date-purge-btn').disabled = true;
  _approachDatePreviewOk = false;
  try {
    const d = await _api('/api/maintenance/approach/date-purge', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    _setStatus('approach-date-purge-result', `Deleted: ${_fmt(d.approaches_deleted)} approach records`);
    document.getElementById('approach-date-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('approach-date-purge-result', `Error: ${e.message}`, true);
  }
});

// ── Flight date-range purge ───────────────────────────────────────────────────

let _flightDatePreviewOk = false;

document.getElementById('flight-date-preview-btn').addEventListener('click', async () => {
  _flightDatePreviewOk = false;
  document.getElementById('flight-date-purge-btn').disabled = true;
  document.getElementById('flight-date-preview-result').textContent = 'Loading\u2026';
  document.getElementById('flight-date-purge-result').textContent = '';
  const date_from = document.getElementById('flight-date-from').value;
  const date_to   = document.getElementById('flight-date-to').value;
  try {
    const d = await _api('/api/maintenance/flight/date-preview', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    const msg = `Will delete: ${_fmt(d.observations)} observations, ${_fmt(d.flights)} flights`
      + ` · ${d.date_from} to ${d.date_to}`;
    document.getElementById('flight-date-preview-result').textContent = msg;
    if (d.observations > 0 || d.flights > 0) {
      _flightDatePreviewOk = true;
      document.getElementById('flight-date-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('flight-date-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('flight-date-purge-btn').addEventListener('click', async () => {
  if (!_flightDatePreviewOk) return;
  const date_from = document.getElementById('flight-date-from').value;
  const date_to   = document.getElementById('flight-date-to').value;
  if (!confirm(`Permanently delete flight & observation records from ${date_from} to ${date_to}?`)) return;
  document.getElementById('flight-date-purge-btn').disabled = true;
  _flightDatePreviewOk = false;
  try {
    const d = await _api('/api/maintenance/flight/date-purge', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    _setStatus('flight-date-purge-result',
      `Deleted: ${_fmt(d.observations_deleted)} observations, ${_fmt(d.flights_deleted)} flights` +
      (d.archived ? ` (archived first: ${_fmt(d.archived.observations)} observations)` : ''));
    loadArchives();
    document.getElementById('flight-date-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('flight-date-purge-result', `Error: ${e.message}`, true);
  }
});

// ── GPS date-range purge ──────────────────────────────────────────────────────

let _gpsDatePreviewOk = false;

document.getElementById('gps-date-preview-btn').addEventListener('click', async () => {
  _gpsDatePreviewOk = false;
  document.getElementById('gps-date-purge-btn').disabled = true;
  document.getElementById('gps-date-preview-result').textContent = 'Loading\u2026';
  document.getElementById('gps-date-purge-result').textContent = '';
  const date_from = document.getElementById('gps-date-from').value;
  const date_to   = document.getElementById('gps-date-to').value;
  try {
    const d = await _api('/api/maintenance/gps/date-preview', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    const msg = `Will delete: ${_fmt(d.gps_quality_hours)} hourly rows, `
      + `${_fmt(d.gps_quality_zone_hours)} zone rows · ${d.date_from} to ${d.date_to}`;
    document.getElementById('gps-date-preview-result').textContent = msg;
    if (d.gps_quality_hours > 0 || d.gps_quality_zone_hours > 0) {
      _gpsDatePreviewOk = true;
      document.getElementById('gps-date-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('gps-date-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('gps-date-purge-btn').addEventListener('click', async () => {
  if (!_gpsDatePreviewOk) return;
  const date_from = document.getElementById('gps-date-from').value;
  const date_to   = document.getElementById('gps-date-to').value;
  if (!confirm(`Permanently delete GPS quality records from ${date_from} to ${date_to}?`)) return;
  document.getElementById('gps-date-purge-btn').disabled = true;
  _gpsDatePreviewOk = false;
  try {
    const d = await _api('/api/maintenance/gps/date-purge', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    _setStatus('gps-date-purge-result',
      `Deleted: ${_fmt(d.gps_quality_hours_deleted)} hourly rows, ${_fmt(d.gps_quality_zone_hours_deleted)} zone rows`);
    document.getElementById('gps-date-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('gps-date-purge-result', `Error: ${e.message}`, true);
  }
});

// ── GPS degradation episode log purge (older than N days) ─────────────────────

let _episodesPreviewOk = false;

document.getElementById('episodes-preview-btn').addEventListener('click', async () => {
  _episodesPreviewOk = false;
  document.getElementById('episodes-purge-btn').disabled = true;
  document.getElementById('episodes-preview-result').textContent = 'Loading\u2026';
  document.getElementById('episodes-purge-result').textContent = '';
  const days = parseInt(document.getElementById('episodes-days').value, 10) || 365;
  try {
    const d = await _api('/api/maintenance/episodes/preview', { days });
    const msg = `Will delete: ${_fmt(d.episodes)} episodes`
      + (d.range_oldest ? ` · from ${d.range_oldest} to ${d.range_newest}` : ' (none)')
      + ` · cutoff: ${d.cutoff_date}`;
    document.getElementById('episodes-preview-result').textContent = msg;
    if (d.episodes > 0) {
      _episodesPreviewOk = true;
      document.getElementById('episodes-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('episodes-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('episodes-purge-btn').addEventListener('click', async () => {
  if (!_episodesPreviewOk) return;
  if (!confirm('Permanently delete the previewed GPS degradation episodes?')) return;
  document.getElementById('episodes-purge-btn').disabled = true;
  _episodesPreviewOk = false;
  const days = parseInt(document.getElementById('episodes-days').value, 10) || 365;
  try {
    const d = await _api('/api/maintenance/episodes/purge', { days });
    _setStatus('episodes-purge-result', `Deleted: ${_fmt(d.episodes_deleted)} episodes`);
    document.getElementById('episodes-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('episodes-purge-result', `Error: ${e.message}`, true);
  }
});

// ── GPS degradation episode log date-range purge ──────────────────────────────

let _episodesDatePreviewOk = false;

document.getElementById('episodes-date-preview-btn').addEventListener('click', async () => {
  _episodesDatePreviewOk = false;
  document.getElementById('episodes-date-purge-btn').disabled = true;
  document.getElementById('episodes-date-preview-result').textContent = 'Loading\u2026';
  document.getElementById('episodes-date-purge-result').textContent = '';
  const date_from = document.getElementById('episodes-date-from').value;
  const date_to   = document.getElementById('episodes-date-to').value;
  try {
    const d = await _api('/api/maintenance/episodes/date-preview', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    const msg = `Will delete: ${_fmt(d.episodes)} episodes · ${d.date_from} to ${d.date_to}`;
    document.getElementById('episodes-date-preview-result').textContent = msg;
    if (d.episodes > 0) {
      _episodesDatePreviewOk = true;
      document.getElementById('episodes-date-purge-btn').disabled = false;
    }
  } catch (e) {
    document.getElementById('episodes-date-preview-result').textContent = `Error: ${e.message}`;
  }
});

document.getElementById('episodes-date-purge-btn').addEventListener('click', async () => {
  if (!_episodesDatePreviewOk) return;
  const date_from = document.getElementById('episodes-date-from').value;
  const date_to   = document.getElementById('episodes-date-to').value;
  if (!confirm(`Permanently delete GPS degradation episodes from ${date_from} to ${date_to}?`)) return;
  document.getElementById('episodes-date-purge-btn').disabled = true;
  _episodesDatePreviewOk = false;
  try {
    const d = await _api('/api/maintenance/episodes/date-purge', { date_from, date_to });
    if (d.error) throw new Error(d.error);
    _setStatus('episodes-date-purge-result', `Deleted: ${_fmt(d.episodes_deleted)} episodes`);
    document.getElementById('episodes-date-preview-result').textContent = '';
    await loadStats();
  } catch (e) {
    _setStatus('episodes-date-purge-result', `Error: ${e.message}`, true);
  }
});

// ── Statistics page history (msg_stats_hours) ────────────────────────────────

document.getElementById('msgstats-clear-btn').addEventListener('click', async ev => {
  ev.stopPropagation();
  if (!_unlocked) return;
  if (!confirm('Delete the stored Statistics page history (msg_stats_hours)? The counts in memory stay until the next restart.')) return;
  try {
    await _api('/api/maintenance/msgstats/purge');
    await loadStats();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
});
