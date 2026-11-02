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
    if (d.departure_series) _fill('stat-depseries', d.departure_series);
    if (d.height_series) _fill('stat-hseries', d.height_series);
    if (d.msg_stats_hours) _fill('stat-msgstats', d.msg_stats_hours);
    if (d.special_visits) _fill('stat-spvisits', d.special_visits);
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
      const obs = f.obs_rows != null ? _fmt(f.obs_rows) : (f.gzip ? 'gzip' : '—');
      row.innerHTML = `<span title="${f.kind}">${esc(f.file)}</span><span>${f.size_mb} MB</span>` +
        `<span>${obs}${extra ? ' · ' + esc(extra) : ''}</span>` +
        `<span>${_utc(f.first)}</span><span>${_utc(f.last)}</span><span class="maint-arc-act"></span>`;
      const act = row.querySelector('.maint-arc-act');
      const dl = document.createElement('button');
      dl.className = 'maint-btn maint-btn-sm';
      dl.textContent = 'Download';
      dl.title = `Download ${f.file} (${f.size_mb} MB)`;
      dl.addEventListener('click', () => downloadArchive(f.file));
      act.appendChild(dl);
      if (f.kind === 'snapshot') {
        const del = document.createElement('button');
        del.className = 'maint-btn maint-btn-sm maint-btn-danger';
        del.textContent = 'Delete';
        del.addEventListener('click', () => deleteSnapshot(f.file, f.size_mb));
        act.appendChild(del);
      }
      list.appendChild(row);
    }
    const sn = s.snapshot || {};
    if (sn.running) {
      _setStatus('snapshot-status', sn.phase === 'gzip' ? `Compressing ${sn.file}…` : `Writing ${sn.file}…`);
      clearTimeout(_snapTimer); _snapTimer = setTimeout(loadArchives, 3000);
    } else if (sn.error) {
      _setStatus('snapshot-status', `Snapshot failed: ${sn.error}`, true);
    } else if (sn.file && sn.finished && (d.files || []).some(f => f.file === sn.file)) {
      _setStatus('snapshot-status', `Snapshot ${sn.file} written (${sn.size_mb} MB)`);
    }
  } catch (e) {
    _setStatus('snapshot-status', `Error: ${e.message}`, true);
  }
}

async function downloadArchive(file) {
  try {
    const d = await _api('/api/maintenance/archive/download-link', { file });
    if (!d.url) throw new Error(d.error || 'no link');
    const a = document.createElement('a');           // the browser saves it (Content-Disposition)
    a.href = d.url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    _setStatus('snapshot-status', `Download of ${file} started`);
  } catch (e) {
    _setStatus('snapshot-status', `Download failed: ${e.message}`, true);
  }
}

async function deleteSnapshot(file, sizeMb) {
  if (!confirm(`Delete snapshot ${file} (${sizeMb} MB)? This cannot be undone.`)) return;
  try {
    const d = await _api('/api/maintenance/archive/delete', { file });
    if (!d.ok) throw new Error(d.error || 'failed');
    _setStatus('snapshot-status', `Deleted ${file} (${d.size_mb} MB)`);
    loadArchives();
  } catch (e) {
    _setStatus('snapshot-status', `Delete failed: ${e.message}`, true);
  }
}

document.getElementById('archive-refresh-btn').addEventListener('click', loadArchives);
document.getElementById('snapshot-btn').addEventListener('click', async () => {
  const compress = document.getElementById('snapshot-gzip').checked;
  if (!confirm('Write a compact copy of the whole database to the archive folder now' +
               (compress ? ', gzip-compressed' : '') + '? ' +
               'This takes a while and needs free space up to ' +
               (compress ? '1.5 × ' : '') + 'the database size.')) return;
  try {
    const d = await _api('/api/maintenance/archive/snapshot', { compress });
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

// Users' first and last names (from 2026-10-28): sent only to the maintenance
// login, decrypted by the server with the maintenance password for that answer.
let _usersData = null;
const _normQ = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]/g, '');

function renderUsers(d) {
  _usersData = d;
  const list = document.getElementById('users-list');
  document.getElementById('users-file').textContent = d.file || '(no file: MAINTENANCE_AUTH_FILE not set)';
  document.getElementById('users-names-locked').style.display = d.names === 'locked' ? '' : 'none';
  const q = _normQ(document.getElementById('users-filter').value);
  const sortBy = document.getElementById('users-sort').value;
  let rows = (d.users || []).filter(u => !q || _normQ(u.user).includes(q) || _normQ(`${u.first || ''}${u.last || ''}`).includes(q)
                                      || _normQ(`${u.last || ''}${u.first || ''}`).includes(q));
  if (sortBy === 'last') {
    // the built-in and maintenance users first, then by last name (users without a name last)
    const grp = u => u.kind !== 'user' ? 0 : u.last ? 1 : 2;
    const key = u => u.kind !== 'user' ? u.user : `${u.last || ''} ${u.first || ''} ${u.user}`;
    rows = rows.slice().sort((a, b) => grp(a) - grp(b) || key(a).localeCompare(key(b), 'fi'));
  }
  const nUsers = (d.users || []).filter(u => u.kind === 'user').length;
  const nNoName = (d.users || []).filter(u => u.kind === 'user' && !u.first).length;
  document.getElementById('users-count').textContent =
    `${nUsers} personal user${nUsers === 1 ? '' : 's'}${nNoName && d.names !== 'locked' ? ` · ${nNoName} without a name` : ''}` +
    (q ? ` · ${rows.length} shown` : '');
  list.innerHTML = rows.map(u => {
    const nm = u.kind !== 'user' ? '<span class="maint-user-name none">—</span>'
      : u.first ? `<span class="maint-user-name" title="${_esc(u.first + ' ' + u.last)}">${_esc(u.first)} ${_esc(u.last)}</span>`
      : `<span class="maint-user-name none">${d.names === 'locked' ? 'cannot be read' : 'no name yet'}</span>`;
    const nameBtn = u.kind === 'user' && d.names !== 'locked'
      ? `<button class="maint-btn maint-btn-sm" data-act="name" data-user="${_esc(u.user)}">Name</button>` : '';
    const edit = u.kind !== 'config'
      ? `<button class="maint-btn maint-btn-sm" data-act="pw" data-user="${_esc(u.user)}">New password</button>` : '';
    const del = u.kind === 'user'
      ? `<button class="maint-btn maint-btn-sm maint-btn-danger" data-act="rm" data-user="${_esc(u.user)}">Remove</button>` : '';
    const rxBtn = u.kind === 'user'
      ? `<button class="maint-btn maint-btn-sm" data-act="rx" data-user="${_esc(u.user)}" title="What ${_esc(u.user)} sees on the Statistics page: own receivers and / or Full view">Receivers</button>` : '';
    return `<div class="maint-stat-row maint-user-row"><span>${_esc(u.user)}</span>${nm}` +
      `<span class="maint-user-kind">${_USER_KIND[u.kind] || u.kind}${u.kind === 'maintenance' && u.hashed === false ? ' · password in clear' : ''}${u.kind === 'config' && d.shared && d.shared.phase !== 'none' ? (d.shared.phase === 'ended' ? ' · shared, ended' : ` · shared, until ${_esc(d.shared.expires)}`) : ''}</span>` +
      `<span class="maint-rx-chips">${_rxChips(u, d)}</span>` +
      `<span>${u.changed ? _utc(u.changed) : '—'}</span><span class="maint-user-actions">${rxBtn}${nameBtn}${edit}${del}</span></div>`;
  }).join('');
  _rxOverview(d);
  if (!d.writable) _setStatus('users-status', 'The folder of the users file is not writable — users cannot be changed.', true);
  if (d.shared) renderShared(d.shared);
}

// ── Receiver rights (web/rights.py, from 2026-11-02) ──────────────────────────
// Everyone sees All receivers on the Statistics page; a user's own receivers and
// Full view (every receiver) are set here; the maintenance user always has Full view.
let _rxUser = null;
function _rxName(d, id) {
  const r = (d.receivers || []).find(x => x.id === id);
  return r ? (r.name ? `${id} · ${r.name}` : id) : null;
}
function _rxChips(u, d) {
  if (u.kind === 'config') return '<span class="maint-rx-chip dim" title="The built-in user always sees All receivers only">All receivers</span>';
  const ch = [];
  if (u.full) ch.push(`<span class="maint-rx-chip full" title="Every receiver's own statistics${u.kind === 'maintenance' ? ' — always for the maintenance user' : ''}">Full view</span>`);
  (u.own || []).forEach(id => {
    const known = (d.receivers || []).some(x => x.id === id);
    ch.push(`<span class="maint-rx-chip${known ? '' : ' gone'}" title="${known ? 'Own receiver: ' + _esc(_rxName(d, id)) : _esc(id) + ': not configured on this server (kept)'}">${_esc(id)}</span>`);
  });
  if (!ch.length) ch.push('<span class="maint-rx-chip dim">All receivers</span>');
  return ch.join('');
}
function _rxOverview(d) {
  const el = document.getElementById('users-rx-overview');
  if (!el) return;
  const rx = d.receivers || [], users = d.users || [];
  if (!rx.length) { el.innerHTML = ''; return; }
  const own = id => users.filter(u => (u.own || []).includes(id)).map(u => `<b>${_esc(u.user)}</b>`);
  const full = users.filter(u => u.full).map(u => `<b>${_esc(u.user)}</b>${u.kind === 'maintenance' ? ' (always)' : ''}`);
  el.innerHTML = `<b>Receivers on this server:</b> ` + rx.map(r => {
      const o = own(r.id);
      return `${_esc(r.id)}${r.name ? ' · ' + _esc(r.name) : ''} — ${o.length ? 'owner' + (o.length > 1 ? 's ' : ' ') + o.join(', ') : '<i>no owner</i>'}`;
    }).join(' &nbsp;·&nbsp; ')
    + ` &nbsp;·&nbsp; Full view: ${full.join(', ') || '—'}. `
    + (rx.length < 2 ? 'With one receiver everyone sees its statistics; the rights take effect when more receivers are added. '
                     : 'Everyone else sees only <i>All receivers</i> on the Statistics page and the phone. ')
    + 'A user can have Full view and own receivers at the same time; the receivers\' own statistics, their feeds in the system health and their own coverage lines on the Live Map follow the same rights.';
}
function _closeRx() {
  _rxUser = null;
  document.getElementById('users-rx-row').style.display = 'none';
}
function _openRx(name) {
  const d = _usersData || {}, u = (d.users || []).find(x => x.user === name) || {};
  _rxUser = name;
  document.getElementById('users-rx-user').textContent = name;
  document.getElementById('users-rx-full').checked = !!u.full;
  const ids = (d.receivers || []).map(r => r.id);
  (u.own || []).forEach(id => { if (!ids.includes(id)) ids.push(id); });
  document.getElementById('users-rx-list').innerHTML = ids.map(id => {
    const nm = _rxName(d, id);
    return `<label><input type="checkbox" value="${_esc(id)}"${(u.own || []).includes(id) ? ' checked' : ''}> ${_esc(nm || id + ' (not on this server)')}</label>`;
  }).join('') || '<span class="maint-user-kind">no receivers</span>';
  document.getElementById('users-rx-row').style.display = '';
}
document.getElementById('users-rx-cancel-btn').addEventListener('click', _closeRx);
document.getElementById('users-rx-save-btn').addEventListener('click', async () => {
  if (!_rxUser) return;
  const own = [...document.querySelectorAll('#users-rx-list input:checked')].map(x => x.value);
  const full = document.getElementById('users-rx-full').checked;
  try {
    renderUsers(await _usersCall('rights', _rxUser, '', { full, own }));
    _setStatus('users-status', `✓ Statistics rights saved for ${_rxUser}: ` + (full ? 'Full view' : '') + (full && own.length ? ' + ' : '')
      + (own.length ? 'own ' + own.join(', ') : '') + (!full && !own.length ? 'All receivers only' : ''));
    _closeRx();
  } catch (err) { _setStatus('users-status', `Error: ${err.message}`, true); }
});

// ── Shared test login: end date (web/shared_login.py) ────────────────────────
function renderShared(sh) {
  const inp = document.getElementById('shared-exp-date');
  if (inp && document.activeElement !== inp) inp.value = sh.expires || '';
  const u = sh.usage || {};
  const ago = u.last ? Math.round((Date.now() / 1000 - u.last) / 60) : null;
  const agoTxt = ago == null ? 'not used since this was set up' :
    ago < 90 ? `last used ${ago} min ago` : ago < 2880 ? `last used ${Math.round(ago / 60)} h ago` : `last used ${Math.round(ago / 1440)} days ago`;
  const phase = { none: 'no end date — works as before', grace: `works until ${sh.expires} (${sh.days_left} days left)`,
                  last: `works until ${sh.expires} (${sh.days_left} day${sh.days_left === 1 ? '' : 's'} left — notice on every page load)`,
                  ended: `ended after ${sh.expires} — opens only the notice` }[sh.phase] || '';
  document.getElementById('shared-exp-info').innerHTML =
    `<b>${_esc(sh.user)}</b>: ${_esc(phase)} · ${_esc(agoTxt)} · last 7 days: used on ${u.days_7 || 0} day(s), ${u.pages_7 || 0} page loads`;
}
async function _sharedSet(expires) {
  try {
    const r = await fetch('/api/maintenance/users/shared', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: _user, password: _pass, expires }),
    });
    if (r.status === 401) throw new Error('Unauthorized');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    renderUsers(d);
    _setStatus('shared-exp-status', expires === 'now' ? '✓ The shared login has ended' : expires ? `✓ Works until ${expires}` : '✓ No end date');
  } catch (err) { _setStatus('shared-exp-status', `Error: ${err.message}`, true); }
}

async function loadUsers() {
  try { renderUsers(await _api('/api/maintenance/users/list')); }
  catch (e) { _setStatus('users-status', `Error: ${e.message}`, true); }
}

async function _usersCall(action, target, pw, extra) {
  const r = await fetch(`/api/maintenance/users/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: _user, password: _pass, target, new_password: pw, ...(extra || {}) }),
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

function _closeName() {
  _nameUser = null;
  document.getElementById('users-name-row').style.display = 'none';
  document.getElementById('users-name-first').value = document.getElementById('users-name-last').value = '';
}
let _nameUser = null;

document.getElementById('users-refresh-btn').addEventListener('click', loadUsers);
document.getElementById('users-filter').addEventListener('input', () => { if (_usersData) renderUsers(_usersData); });
try { document.getElementById('users-sort').value = localStorage.getItem('ms_maintUserSort') || 'user'; } catch (e) { /* */ }
document.getElementById('users-sort').addEventListener('change', e => {
  try { localStorage.setItem('ms_maintUserSort', e.target.value); } catch (err) { /* */ }
  if (_usersData) renderUsers(_usersData);
});
document.getElementById('users-names-reset-btn').addEventListener('click', async () => {
  if (!confirm('Start the names again? The stored names cannot be read with the current maintenance password and will be discarded; the users stay and their names can be entered again.')) return;
  try { renderUsers(await _usersCall('names-reset', '')); _setStatus('users-status', '✓ The names were started again — add them with Name'); }
  catch (err) { _setStatus('users-status', `Error: ${err.message}`, true); }
});
document.getElementById('users-name-cancel-btn').addEventListener('click', _closeName);
document.getElementById('users-name-save-btn').addEventListener('click', async () => {
  if (!_nameUser) return;
  const first = document.getElementById('users-name-first').value.trim(), last = document.getElementById('users-name-last').value.trim();
  if (!first || !last) { _setStatus('users-status', 'Enter the first and the last name.', true); return; }
  try {
    renderUsers(await _usersCall('name', _nameUser, '', { first, last }));
    _setStatus('users-status', `✓ Name saved for ${_nameUser}`);
    _closeName();
  } catch (err) { _setStatus('users-status', `Error: ${err.message}`, true); }
});
document.getElementById('users-list').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const name = b.dataset.user;
  if (b.dataset.act === 'rx') {
    _closeEdit(); _closeName();
    _openRx(name);
    return;
  }
  if (b.dataset.act === 'name') {
    _closeEdit(); _closeRx();
    _nameUser = name;
    const u = (_usersData && _usersData.users || []).find(x => x.user === name) || {};
    document.getElementById('users-name-user').textContent = name;
    document.getElementById('users-name-first').value = u.first || '';
    document.getElementById('users-name-last').value = u.last || '';
    document.getElementById('users-name-row').style.display = '';
    document.getElementById('users-name-first').focus();
    return;
  }
  if (b.dataset.act === 'pw') {
    _closeName(); _closeRx();
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
    if (_nameUser === name) _closeName();
    if (_rxUser === name) _closeRx();
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
  const first = document.getElementById('users-add-first').value.trim(), last = document.getElementById('users-add-last').value.trim();
  const p1 = document.getElementById('users-add-pass').value, p2 = document.getElementById('users-add-pass2').value;
  if (!name) { _setStatus('users-status', 'Enter a username.', true); return; }
  if (!first || !last) { _setStatus('users-status', 'Enter the first and the last name.', true); return; }
  if (p1 !== p2) { _setStatus('users-status', 'The passwords do not match.', true); return; }
  try {
    renderUsers(await _usersCall('add', name, p1, { first, last }));
    _setStatus('users-status', `✓ ${name} added`);
    ['users-add-name', 'users-add-first', 'users-add-last', 'users-add-pass', 'users-add-pass2'].forEach(id => { document.getElementById(id).value = ''; });
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
    await loadRegdb();
    await loadMast();
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

document.getElementById('shared-exp-save-btn').addEventListener('click', () => {
  const v = document.getElementById('shared-exp-date').value;
  if (!v) { _setStatus('shared-exp-status', 'Choose a date (or No end date).', true); return; }
  _sharedSet(v);
});
document.getElementById('shared-exp-now-btn').addEventListener('click', () => {
  if (!confirm('End the shared test login now? Its users then see only the notice with your contact details.')) return;
  _sharedSet('now');
});
document.getElementById('shared-exp-none-btn').addEventListener('click', () => _sharedSet(''));

// ── Aircraft database: daily BaseStation.sqb update + visit log (2026-11-01) ──

let _regdbPoll = null;

function _num(n) { return n != null ? Number(n).toLocaleString('fi-FI') : '—'; }

function _regdbLine(label, dot, html) {
  return `<b>${label}</b><span>${dot ? `<span class="regdb-dot ${dot}"></span>` : ''}${html}</span>`;
}

function _runText(r) {
  if (!r) return 'No update has run yet.';
  const f = r.fill;
  const parts = [];
  if (f) {
    parts.push(`${_num(f.heard)} aircraft heard in the last ${document.getElementById('regdb-heard-days').textContent} days checked: `
      + `<b>${_num(f.regs)}</b> registrations and <b>${_num(f.types)}</b> types filled, `
      + `<b>${_num(f.fixed)}</b> types corrected${f.examples && f.examples.length ? ` (e.g. ${_esc(f.examples.slice(0, 3).join(', '))})` : ''}`
      + ` · ${_num(f.unknown)} still without a registration · ${_num(f.diffs)} registration differences`);
  }
  if (r.notes && r.notes.length) parts.push(_esc(r.notes.join(' · ')));
  if (r.errors && r.errors.length) parts.push(`<span class="maint-status-error">${_esc(r.errors.join(' · '))} — the existing files stay in use</span>`);
  return `${_esc(r.utc || '')} (${_esc(r.reason || '')}, ${r.dur} s) — ${parts.join('. ')}`;
}

function renderRegdb(d) {
  const s = d.settings || {};
  document.getElementById('regdb-enabled').checked = !!s.enabled;
  document.getElementById('regdb-time').value = s.time || '04:30';
  document.getElementById('regdb-src-tar1090').checked = !!s.src_tar1090;
  document.getElementById('regdb-src-alert').checked = !!s.src_alert;
  document.getElementById('regdb-types').value = s.types || 'correct';
  document.getElementById('regdb-heard-days').textContent = d.heard_days || 30;

  const bs = d.bs || {}, m = d.meta || {};
  let h = '';
  if (bs.open) {
    const dt = bs.mtime ? new Date(bs.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
    h += _regdbLine('BaseStation.sqb', 'ok', `In use — ${_esc(bs.path || '')} · ${_num(bs.aircraft)} aircraft · file ${dt}`);
  } else if (bs.exists) {
    h += _regdbLine('BaseStation.sqb', 'warn', `Found but could not be opened${bs.error ? ' (' + _esc(bs.error) + ')' : ''}`);
  } else {
    h += _regdbLine('BaseStation.sqb', 'off', `Not found (${_esc(bs.path || '—')}) — created by the first update`);
  }
  h += _regdbLine('Reference: tar1090-db', m.ac_entries ? 'ok' : 'off',
    m.ac_entries ? `${_num(m.ac_entries)} aircraft (${_num(m.ac_mil)} military) · downloaded ${_esc(m.ac_downloaded || '—')}`
                 : 'Not downloaded yet');
  h += _regdbLine('Military / government list', m.alert_entries ? 'ok' : 'off',
    m.alert_entries ? `plane-alert-db ${_num(m.alert_entries)} aircraft · downloaded ${_esc(m.alert_downloaded || '—')}`
                    : 'plane-alert-db not downloaded yet (tar1090-db military flag used)');
  const upd = d.running ? `<span class="maint-status-ok">Running — ${_esc(d.phase || '…')}</span>`
    : (!s.enabled ? 'Off — no network requests'
      : `Daily at ${_esc(s.time)} UTC · last success ${_esc(m.ok || '—')}`
        + (m.last_ok === '0' ? ' · <span class="maint-status-error">last attempt failed</span>' : ''));
  h += _regdbLine('Daily update', d.running ? 'ok' : (!s.enabled ? 'off' : (m.last_ok === '0' ? 'warn' : 'ok')), upd);
  h += _regdbLine('Lookups since start', '',
    `${_num(bs.lookups)} aircraft without a registration or type in the receiver's list · ${_num(bs.found)} registrations found`
    + (bs.found_ref ? ` (${_num(bs.found_ref)} from tar1090-db)` : ''));
  document.getElementById('regdb-status').innerHTML = h;

  document.getElementById('regdb-last').innerHTML = _runText(d.last_run);
  const hist = (d.history || []).slice(1, 6).map(r =>
    `${_esc((r.utc || '').replace(' UTC', ''))} ${r.ok ? '✓' : '✗ ' + _esc((r.errors || [])[0] || '')}`);
  document.getElementById('regdb-history').textContent = hist.length ? 'Previous runs: ' + hist.join(' · ') : '';
  const undoBtn = document.getElementById('regdb-undo-btn');
  undoBtn.disabled = !d.undo || d.running;
  undoBtn.title = d.undo ? `Restore the ${d.undo.rows} BaseStation.sqb rows changed by the run of ${d.undo.utc}` : 'Nothing to undo';
  document.getElementById('regdb-run-btn').disabled = !!d.running;

  // registration differences
  const diffs = d.diffs || [];
  document.getElementById('regdb-diffs-n').textContent = `(${d.diffs_total != null ? d.diffs_total : diffs.length})`;
  const dEl = document.getElementById('regdb-diffs');
  if (!diffs.length) {
    dEl.innerHTML = '<span class="maint-hint">No differences between BaseStation.sqb and tar1090-db for the aircraft heard.</span>';
  } else {
    dEl.innerHTML = `<div class="regdb-tbl-wrap"><table class="regdb-tbl"><thead><tr><th><input type="checkbox" id="regdb-diff-all"></th>
      <th>ICAO24</th><th>BaseStation.sqb</th><th>tar1090-db</th><th>Type in tar1090-db</th><th>Last heard</th></tr></thead><tbody>`
      + diffs.map(x => `<tr><td><input type="checkbox" class="regdb-diff-cb" value="${_esc(x.icao)}"></td>
        <td>${_esc(x.icao)}</td><td>${_esc(x.ours)}</td><td>${_esc(x.theirs)}</td><td>${_esc(x.type || '')}</td><td>${_esc(x.heard || '')}</td></tr>`).join('')
      + '</tbody></table></div>';
    document.getElementById('regdb-diff-all').addEventListener('change', e => {
      dEl.querySelectorAll('.regdb-diff-cb').forEach(cb => { cb.checked = e.target.checked; });
      _regdbSel();
    });
    dEl.querySelectorAll('.regdb-diff-cb').forEach(cb => cb.addEventListener('change', _regdbSel));
  }
  _regdbSel();
  const hid = document.getElementById('regdb-hidden');
  hid.innerHTML = d.hidden ? `${d.hidden} kept earlier are hidden · <a href="#" id="regdb-unhide">show again</a>` : '';
  const un = document.getElementById('regdb-unhide');
  if (un) un.addEventListener('click', async ev => { ev.preventDefault(); await _regdbAction('unhide', []); });

  renderVisits(d.visits || {});

  clearTimeout(_regdbPoll);
  if (d.running) _regdbPoll = setTimeout(loadRegdb, 3000);
}

function _regdbSel() {
  const n = document.querySelectorAll('.regdb-diff-cb:checked').length;
  document.getElementById('regdb-use-btn').disabled = !n;
  document.getElementById('regdb-keep-btn').disabled = !n;
}

function _clsPill(c) {
  const t = { mil: 'Military', gov: 'Government', pol: 'Police' }[c] || c;
  return `<span class="regdb-pill ${_esc(c)}">${_esc(t)}</span>`;
}

function renderVisits(v) {
  const st = v.settings || {};
  document.getElementById('mil-enabled').checked = st.enabled !== false;
  if (st.days) document.getElementById('mil-days').value = st.days;
  const dEl = document.getElementById('mil-days-table');
  const rEl = document.getElementById('mil-recent');
  if (v.error) { dEl.innerHTML = `<span class="maint-status-error">${_esc(v.error)}</span>`; rEl.innerHTML = ''; return; }
  const days = v.days || [];
  dEl.innerHTML = !days.length
    ? `<span class="maint-hint">No visits logged yet${v.open ? ` (${v.open} visit${v.open === 1 ? '' : 's'} in progress)` : ''}.</span>`
    : `<table class="regdb-tbl"><thead><tr><th>Day (UTC)</th><th>Visits</th><th>Aircraft</th><th>Military</th><th>Government / police</th>
        <th>Closest</th><th>Own GNSS degraded</th></tr></thead><tbody>`
      + days.map(x => `<tr><td>${_esc(x.day)}</td><td>${x.visits}</td><td>${x.aircraft}</td><td>${x.mil}</td><td>${x.gov}</td>
        <td>${x.closest != null ? x.closest.toFixed(0) + ' NM' : '—'}</td><td>${x.deg}</td></tr>`).join('')
      + '</tbody></table>';
  const rec = v.recent || [];
  const t = s => new Date(s * 1000).toISOString().slice(5, 16).replace('T', ' ');
  const fl = a => a == null ? '' : (a >= 10000 ? 'FL' + String(Math.round(a / 100)).padStart(3, '0') : Math.round(a) + ' ft');
  rEl.innerHTML = !rec.length ? '<span class="maint-hint">—</span>'
    : `<table class="regdb-tbl"><thead><tr><th>First heard</th><th>Min</th><th>Callsign</th><th>Class</th><th>Operator / type</th>
        <th>Country</th><th>Closest</th><th>Altitude</th><th>Own GNSS</th></tr></thead><tbody>`
      + rec.map(x => `<tr><td>${t(x.t_first)}</td><td>${Math.max(1, Math.round((x.t_last - x.t_first) / 60))}</td>
        <td>${_esc(x.callsign || x.registration || '')}</td><td>${_clsPill(x.cls)}</td>
        <td>${_esc([x.operator, x.ac_type || x.descr].filter(Boolean).join(' · '))}</td><td>${_esc(x.country || '')}</td>
        <td>${x.min_dist_nm != null ? x.min_dist_nm.toFixed(0) + ' NM' : '—'}</td>
        <td>${_esc([fl(x.min_alt), fl(x.max_alt)].filter(Boolean).filter((a, i, arr) => arr.indexOf(a) === i).join('–'))}</td>
        <td>${x.sweeps ? (x.deg_sweeps ? Math.round(100 * x.deg_sweeps / x.sweeps) + ' % degraded' : (x.pos_sweeps ? 'normal' : 'no ADS-B position'))
                       : '—'}${x.min_nacp != null ? ` · NACp ≥ ${x.min_nacp}` : ''}</td></tr>`).join('')
      + '</tbody></table>';
}

async function loadRegdb() {
  try {
    renderRegdb(await _api('/api/maintenance/regdb/status'));
  } catch (e) {
    _setStatus('regdb-op-status', `Status not available: ${e.message}`, true);
  }
}

async function _regdbAction(action, icaos) {
  try {
    const r = await _api('/api/maintenance/regdb/run', { action, icaos });
    if (action === 'update') _setStatus('regdb-op-status', r.ok ? 'Update started…' : 'An update is already running.', !r.ok);
    else if (action === 'undo') _setStatus('regdb-op-status', r.busy ? 'An update is running — try again when it has finished.' : `${r.rows} rows restored.`, !!r.busy);
    else _setStatus('regdb-op-status', `${r.n} difference${r.n === 1 ? '' : 's'} ${action === 'use' ? 'updated in BaseStation.sqb' : action === 'keep' ? 'hidden' : 'listed again after the next update'}.`);
  } catch (e) {
    _setStatus('regdb-op-status', e.message, true);
  }
  await loadRegdb();
}

function _selDiffs() {
  return [...document.querySelectorAll('.regdb-diff-cb:checked')].map(cb => cb.value);
}

document.getElementById('regdb-refresh-btn').addEventListener('click', loadRegdb);
document.getElementById('regdb-save-btn').addEventListener('click', async () => {
  const time = document.getElementById('regdb-time').value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { _setStatus('regdb-op-status', 'Time as HH:MM (UTC), e.g. 04:30', true); return; }
  try {
    const r = await _api('/api/maintenance/regdb/config', {
      enabled: document.getElementById('regdb-enabled').checked, time,
      src_tar1090: document.getElementById('regdb-src-tar1090').checked,
      src_alert: document.getElementById('regdb-src-alert').checked,
      types: document.getElementById('regdb-types').value,
    });
    const s = r.settings;
    _setStatus('regdb-op-status', s.enabled ? `Saved — daily update at ${s.time} UTC.` : 'Saved — the daily update is off (no network requests).');
  } catch (e) { _setStatus('regdb-op-status', e.message, true); }
  await loadRegdb();
});
document.getElementById('regdb-run-btn').addEventListener('click', () => _regdbAction('update', []));
document.getElementById('regdb-undo-btn').addEventListener('click', () => {
  if (confirmInline('regdb-undo-btn', 'Undo?')) _regdbAction('undo', []);
});
document.getElementById('regdb-use-btn').addEventListener('click', () => _regdbAction('use', _selDiffs()));
document.getElementById('regdb-keep-btn').addEventListener('click', () => _regdbAction('keep', _selDiffs()));
document.getElementById('mil-save-btn').addEventListener('click', async () => {
  try {
    const r = await _api('/api/maintenance/regdb/config', {
      mil_enabled: document.getElementById('mil-enabled').checked,
      mil_days: parseInt(document.getElementById('mil-days').value, 10) || 365,
    });
    _setStatus('regdb-op-status', r.mil.enabled ? `Visit log on, kept ${r.mil.days} days.` : 'Visit log off.');
  } catch (e) { _setStatus('regdb-op-status', e.message, true); }
  await loadRegdb();
});

// ── Kivenlahti mast (collector/mast.py, 2026-11-01) ──────────────────────────
function _utcTs(t) { return t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'; }
async function loadMast() {
  try {
    const d = await _api('/api/maintenance/mast/status');
    const s = d.settings || {};
    document.getElementById('mast-enabled').checked = !!s.enabled;
    const st = d.station || {};
    let h = _regdbLine('Station', '', `${_esc(st.name || '—')} · fmisid ${_esc(String(d.fmisid || '—'))} · ${st.lat != null ? st.lat.toFixed(3) + ' N ' + st.lon.toFixed(3) + ' E' : ''} · ground ${st.elev ?? '—'} m`);
    const age = d.newest ? Date.now() / 1000 - d.newest : null;
    h += _regdbLine('Observations', d.rows ? (age != null && age < 1800 ? 'ok' : 'warn') : 'off',
      d.rows ? `${_num(d.rows)} steps · ${_utcTs(d.first)} … ${_utcTs(d.newest)}` : 'None stored yet');
    const l = d.last;
    h += _regdbLine('Fetching', !s.enabled ? 'off' : (l && !l.ok ? 'warn' : 'ok'),
      !s.enabled ? 'Off — no network requests'
        : (d.running ? 'Fetching…' : l ? `Last look ${_utcTs(l.ts)}: ${_esc(l.text)}` : 'Not looked yet (about a minute after the start)'));
    document.getElementById('mast-status').innerHTML = h;
  } catch (e) {
    _setStatus('mast-op-status', `Status not available: ${e.message}`, true);
  }
}
document.getElementById('mast-refresh-btn').addEventListener('click', loadMast);
document.getElementById('mast-save-btn').addEventListener('click', async () => {
  try {
    const r = await _api('/api/maintenance/mast/config', { enabled: document.getElementById('mast-enabled').checked });
    _setStatus('mast-op-status', r.settings.enabled ? 'Saved — fetching every 10 minutes.' : 'Saved — fetching is off (no network requests).');
  } catch (e) { _setStatus('mast-op-status', e.message, true); }
  await loadMast();
});
document.getElementById('mast-now-btn').addEventListener('click', async () => {
  try {
    const r = await _api('/api/maintenance/mast/config', { fetch_now: true });
    _setStatus('mast-op-status', r.settings.enabled ? 'Fetching…' : 'Fetching is off — switch it on first.', !r.settings.enabled);
  } catch (e) { _setStatus('mast-op-status', e.message, true); }
  setTimeout(loadMast, 4000);
});

// two-click confirmation without a browser dialog
function confirmInline(btnId, label) {
  const b = document.getElementById(btnId);
  if (b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = b.dataset.orig; return true; }
  b.dataset.orig = b.textContent; b.dataset.armed = '1'; b.textContent = label + ' Click again';
  setTimeout(() => { if (b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = b.dataset.orig; } }, 4000);
  return false;
}
