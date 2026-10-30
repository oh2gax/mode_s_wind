/**
 * stats.js — Mode S & ADS-B Statistics page (from 2026-10-25).
 *
 * Polls /api/msgstats every 10 s (not while the tab is hidden) and draws:
 * the summary bar, the message-rate chart (1 h every 10 s, 24 h per
 * minute or 7 d per 10 min, with a choice of series), the downlink formats, the Comm-B
 * registers, the ADS-B type codes, the reply cadence per flight phase, the
 * interrogators of the DF11 all-call replies, the signal-strength histogram
 * (Beast signal byte, dBFS) per message class, the range rings (farthest
 * ADS-B position per 10° sector and altitude band, positions and signal per
 * range band), the Radarcape receiver's own status (GPS flags, GPS module
 * temperature, time sources, uptimes, position, settings — from 2026-10-26),
 * the meteo yield and the Radarcape aircraft list.  The window
 * (1 min / 10 min / 1 h / 24 h / 7 d) is remembered in the browser.
 *
 * System health (from 2026-10-25): /api/health with every poll — a row of
 * coloured dots right of the Window buttons (one chip on narrower screens);
 * a click opens the detail panel (state, reason, details, time in that state,
 * the recent state changes).
 *
 * Mobile view (from 2026-10-28): app.html loads this file for its Statistics
 * view with window.MST_EMBED = {win} set — the same panels (_stats_panels.html)
 * in one column, the window chosen in the app's menu, polling only while the
 * view is shown (window.MsStats.start / stop / setWindow / redraw), short
 * format names, a narrower range table and the health panel shown inline.
 */
(function () {
  'use strict';
  // the chart's range: 24 h by default (from 30 Oct 2026; before 1 h)
  let win = 10, range = '24h', series = 'rate', cadKind = '5,0', sigCat = 'all';
  // Message rate / Data transfer tabs of the chart panel (from 2026-10-27)
  let tab = 'msgs', trView = 'app', trData = null, chartType = null;
  const EMBED = window.MST_EMBED || null;      // the mobile view (from 2026-10-28)
  // every 10 s; on the phone every 30 s (one answer is about 55 kB compressed: ~6.6 MB an hour instead of ~20)
  const POLL_MS = EMBED ? 30000 : 10000;
  let active = !EMBED;
  try {
    win = EMBED ? (+EMBED.win || 1440) : parseInt(localStorage.getItem('ms_statsWindow') || '10', 10) || 10;
    series = localStorage.getItem('ms_statsSeries') || 'rate';
    tab = localStorage.getItem('ms_statsTab') === 'traffic' ? 'traffic' : 'msgs';
    trView = localStorage.getItem('ms_statsTrView') === 'net' ? 'net' : 'app';
    cadKind = localStorage.getItem('ms_statsCad') || '5,0';
    sigCat = localStorage.getItem('ms_statsSig') || 'all';
  } catch (e) { /* private mode */ }
  if (![1, 10, 60, 1440, 10080].includes(win)) win = 10;
  if (EMBED) range = '24h';
  let data = null, chart = null, sigChart = null, timer = null, health = null;

  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (v, d = 1) => v == null ? '—' : Number(v).toFixed(d);
  const fmtRate = v => v == null ? '—' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  const pct = (a, b) => b ? (100 * a / b).toFixed(a / b < 0.1 ? 1 : 0) + ' %' : '—';
  const hhmm = t => { if (!t) return '—'; const d = new Date(t * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
  const ago = s => s == null ? '—' : s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';

  const DF_NAME = {
    0: 'Short air–air surveillance (ACAS)', 4: 'Surveillance reply, altitude', 5: 'Surveillance reply, identity (squawk)',
    11: 'All-call reply / acquisition squitter', 16: 'Long air–air surveillance (ACAS)',
    17: 'Extended squitter (ADS-B)', 18: 'Extended squitter, non-transponder (TIS-B / ADS-R)', 19: 'Military extended squitter',
    20: 'Comm-B reply, altitude', 21: 'Comm-B reply, identity', 24: 'Comm-D extended length message',
  };
  // the phone: one line each (from 2026-10-28)
  const DF_SHORT = {
    0: 'ACAS, short', 4: 'Surveillance, altitude', 5: 'Surveillance, squawk', 11: 'All-call / acquisition', 16: 'ACAS, long',
    17: 'ADS-B', 18: 'TIS-B / ADS-R', 19: 'Military ES', 20: 'Comm-B, altitude', 21: 'Comm-B, squawk', 24: 'Comm-D',
  };
  const BDS_NAME = {
    '1,0': 'Data link capability', '1,7': 'Common-usage GICB capability', '2,0': 'Aircraft identification (callsign)',
    '3,0': 'ACAS resolution advisory', '4,0': 'Selected vertical intention (MCP / FMS altitude, QNH)',
    '4,4': 'Meteorological routine air report (MRAR)', '4,5': 'Meteorological hazard report (MHR)',
    '5,0': 'Track and turn report (track, GS, TAS, roll)', '6,0': 'Heading and speed report (heading, IAS, Mach)',
    '?': 'Not identified by the decoder',
  };
  const TC_GROUPS = [
    [[1, 4], 'Identification (callsign, category)'], [[5, 8], 'Surface position'],
    [[9, 18], 'Airborne position, barometric altitude'], [[19, 19], 'Airborne velocity'],
    [[20, 22], 'Airborne position, GNSS height'], [[23, 27], 'Test / reserved / surface system status'],
    [[28, 28], 'Aircraft status (emergency, ACAS RA)'], [[29, 29], 'Target state and status (selected altitude, QNH)'],
    [[30, 30], 'Reserved'], [[31, 31], 'Operational status (version, NIC / NAC supplements)'],
  ];
  const CAD_NAME = { '5,0': 'BDS 5,0', '6,0': 'BDS 6,0', '4,0': 'BDS 4,0', '2,0': 'BDS 2,0', surv: 'DF4/5', es_pos: 'ADS-B position', es_vel: 'ADS-B velocity' };
  const PHASE_NAME = { final: 'Final', terminal: 'Terminal', enroute: 'En route' };

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ── summary bar ───────────────────────────────────────────────────────────
  function renderBar(d) {
    const ten = (d.ten || []).filter(t => t[1] != null);
    const last = ten.length ? ten[ten.length - 1][1] / 10 : null;
    $('mst-k-rate').textContent = last == null ? '—' : fmtRate(last);
    $('mst-k-rate').title = `Last 10 s: ${last == null ? '—' : fmtRate(last)} /s · window average ${fmtRate(d.totals.rate)} /s`;
    $('mst-k-ac').textContent = d.totals.aircraft;
    $('mst-k-adsb').textContent = d.totals.adsb;
    $('mst-k-ehs').textContent = d.totals.ehs;
    if ($('mst-k-ehsnow')) $('mst-k-ehsnow').textContent = `${d.totals.ehs_now} / ${d.totals.ehs_silent}`;
    const j = d.json || {};
    $('mst-k-mlat').textContent = j.ts ? `${j.mlat} / ${j.adsb}` : '—';
    const f = d.feed;
    const age = f.last_msg_ts ? d.now - f.last_msg_ts : null;
    const el = $('mst-k-feed');
    el.textContent = age == null ? 'no data' : age < 5 ? 'live' : `silent ${ago(age)}`;
    el.className = 'gps-summary-val ' + (age != null && age < 5 ? 'mst-ok' : 'mst-warn');
    el.title = `Last frame ${ago(age)} ago · connected ${f.connected_ts ? ago(d.now - f.connected_ts) : '—'} · `
      + `${f.connects} connection(s) since the server started (${hhmm(f.started)} UTC) · ${f.total_msgs.toLocaleString('en')} frames in all`;
    const ws = d.window_sec;
    $('mst-updated').textContent = `Updated ${hhmm(d.now)}:${String(new Date(d.now * 1000).getUTCSeconds()).padStart(2, '0')} UTC · window `
      + (ws >= 2 * 86400 ? `${(ws / 86400).toFixed(1)} d` : ws >= 7200 ? `${(ws / 3600).toFixed(1)} h` : `${Math.round(ws / 60)} min`);
  }

  // ── tables ────────────────────────────────────────────────────────────────
  function table(id, head, rows) {
    $(id).innerHTML = '<thead><tr>' + head.map(h => `<th${h[1] ? ` title="${esc(h[1])}"` : ''}${h[2] ? ` class="${h[2]}"` : ''}>${h[0]}</th>`).join('') + '</tr></thead><tbody>'
      + (rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="mst-empty">No messages in the window</td></tr>`) + '</tbody>';
  }
  const bar = (frac, cls = '') => `<span class="mst-bar-cell"><span class="mst-fill ${cls}" style="width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%"></span></span>`;

  function renderDf(d) {
    const tot = d.totals.msgs - d.totals.err - d.totals.dec_err - d.totals.blocked;
    const rows = d.df.map(r => `<tr><td class="mst-code">DF${r.df}</td><td>${esc((EMBED ? DF_SHORT[r.df] || DF_NAME[r.df] : DF_NAME[r.df]) || '')}</td>`
      + `<td class="num">${fmtRate(r.rate)}</td><td class="num">${pct(r.n, tot)}</td><td>${bar(tot ? r.n / tot : 0)}</td><td class="num">${r.ac}</td></tr>`);
    table('mst-df', [['DF', 'Downlink format'], ['Meaning'], ['/s', 'Messages per second in the window', 'num'],
      ['Share', 'Of the decoded messages', 'num'], [''], ['Aircraft', 'Distinct aircraft in the window', 'num']], rows);
    const t = d.totals;
    $('mst-df-note').textContent = `${t.short.toLocaleString('en')} short · ${t.long.toLocaleString('en')} long · `
      + `${t.err + t.dec_err} undecodable · ${t.blocked} blocked`;
    $('mst-df-note').title = 'Short = 56-bit, long = 112-bit frames. Undecodable: rejected by the decoder (CRC / parity, unknown format). '
      + 'Blocked: addresses on the ICAO blocklist (BLOCKED_ICAO_PREFIXES).';
  }

  function renderBds(d) {
    const cb = d.commb, ehs = cb.ehs_ac || 0, cbac = cb.ac || 0;
    const rows = cb.bds.sort((a, b) => b.n - a.n).map(r => `<tr><td class="mst-code">${esc(r.bds === '?' ? '—' : r.bds)}</td><td>${esc(BDS_NAME[r.bds] || 'Other')}</td>`
      + `<td class="num">${fmtRate(r.rate)}</td><td class="num">${pct(r.n, cb.total)}</td><td>${bar(cb.total ? r.n / cb.total : 0, 'mst-fill-b')}</td>`
      + `<td class="num">${r.ac}</td><td class="num">${pct(r.ac, cbac)}</td></tr>`);
    table('mst-bds', [['BDS', 'Comm-B data selector (register), as inferred from the reply by pyModeS'], ['Register'],
      ['/s', 'Replies per second', 'num'], ['Share', 'Of the Comm-B replies', 'num'], [''],
      ['Aircraft', 'Distinct aircraft that answered it', 'num'], ['of all', 'Share of the aircraft that sent any Comm-B reply in the window', 'num']], rows);
    $('mst-bds-foot').innerHTML = `${cb.total.toLocaleString('en')} Comm-B replies from ${cbac} aircraft, ${ehs} of them EHS (5,0 / 6,0). `
      + `<span title="The register is not stated in the reply: pyModeS infers it from the content. When the bits fit more than one register it picks one; these are counted here.">Ambiguous inference: ${pct(cb.ambig, cb.total)}</span> · `
      + `<span title="Replies whose address could not be tied to an aircraft already heard (address / parity overlay) — mostly new aircraft or corrupted replies">unverified address: ${pct(cb.unverified, cb.total)}</span>. `
      + `Register 4,0 also carries the aircraft's QNH setting; 4,4 / 4,5 are rarely answered.`;
  }

  function renderTc(d) {
    const tcs = d.adsb.tc;
    const tot = tcs.reduce((s, r) => s + r.n, 0);
    const rows = TC_GROUPS.map(([[a, b], name]) => {
      const sel = tcs.filter(r => r.tc != null && r.tc >= a && r.tc <= b);
      const n = sel.reduce((s, r) => s + r.n, 0);
      if (!n) return null;
      return `<tr><td class="mst-code">${a === b ? a : a + '–' + b}</td><td>${esc(name)}</td><td class="num">${fmtRate(n / d.window_sec)}</td>`
        + `<td class="num">${pct(n, tot)}</td><td>${bar(tot ? n / tot : 0, 'mst-fill-g')}</td></tr>`;
    }).filter(Boolean);
    table('mst-tc', [['TC', 'ADS-B type code'], ['Message'], ['/s', '', 'num'], ['Share', 'Of the DF17 messages', 'num'], ['']], rows);
    const v = d.adsb.v19, vt = Object.values(v).reduce((s, x) => s + x, 0);
    const gs = (v['1'] || 0) + (v['2'] || 0), as = (v['3'] || 0) + (v['4'] || 0);
    const ver = d.adsb.ver, vers = Object.keys(ver).sort().map(k => `v${k}: ${ver[k].ac}`).join(' · ') || '—';
    $('mst-tc-foot').innerHTML = `Velocity: ground speed ${pct(gs, vt)}, airspeed ${pct(as, vt)}; `
      + `<span title="TC 19 carries the difference between the GNSS height and the barometric altitude, used for the heights of the pressure surfaces">GNSS − baro difference in ${pct(d.adsb.gmb, vt)}</span>. `
      + `<span title="ADS-B version from the operational status message (TC 31): aircraft per version">Version (aircraft): ${vers}</span>.`;
  }

  function renderCad(d) {
    const edges = d.cadence.edges;
    const rows = d.cadence.rows.filter(r => r.kind === cadKind);
    const lbl = edges.map((e, i) => i + 1 < edges.length ? `${e}–${edges[i + 1]} s` : `${e}–60 s`);
    const out = ['final', 'terminal', 'enroute'].map(ph => {
      const r = rows.find(x => x.phase === ph);
      if (!r) return `<tr><td>${PHASE_NAME[ph]}</td><td colspan="6" class="mst-empty">—</td></tr>`;
      const mx = Math.max(1, ...r.hist);
      const hist = '<span class="mst-hist">' + r.hist.map((n, i) => `<span style="height:${(100 * n / mx).toFixed(0)}%" title="${esc(lbl[i])}: ${n}"></span>`).join('') + '</span>';
      const all = r.n + r.dup;
      return `<tr><td>${PHASE_NAME[ph]}</td><td class="num"><b>${fmt(r.median, 1)}</b></td><td class="num">${fmt(r.p90, 1)}</td>`
        + `<td class="num">${r.n.toLocaleString('en')}</td><td class="num">${pct(r.dup, all)}</td><td class="num">${r.gaps}</td><td>${hist}</td></tr>`;
    });
    table('mst-cad', [['Phase'], ['Median s', 'Median interval between successive replies', 'num'], ['p90 s', '90 % of the intervals are shorter', 'num'],
      ['Intervals', '', 'num'], ['Dup.', 'Near-duplicate replies (< 0.5 s after the previous one)', 'num'], ['Gaps', 'Pauses over 60 s', 'num'],
      ['0.5 → 60 s', 'Histogram of the intervals (hover a bar)']], out);
  }

  // the use of an interrogator code (ICAO EUR / MID practice, EUROCONTROL MICA): the IC value
  // (II, or SI modulo 16) 1–13 operational Mode S radars, 0 multilateration / WAM / mobile,
  // 14 test and development, 15 military
  function iidClass(type, code) {
    const ic = type === 'II' ? code : code % 16;
    return ic === 0 ? 'MLAT / WAM / mobile' : ic === 14 ? 'test / development' : ic === 15 ? 'military' : 'Mode S radar';
  }
  function renderIid(d) {
    const io = d.iid;
    const sq = io.rows.find(r => r.type === 'SQ');
    const rows = io.rows.filter(r => r.type !== 'SQ').map(r => `<tr><td class="mst-code">${r.type} ${r.code}</td>`
      + `<td class="mst-dim2">${iidClass(r.type, r.code)}</td>`
      + `<td class="num">${fmtRate(r.rate)}</td><td class="num">${r.n.toLocaleString('en')}</td><td class="num">${r.ac ?? '—'}</td>`
      + `<td class="num">${r.first != null && d.now - r.first > 72000 ? new Date(r.first * 1000).getUTCDate() + '.' + (new Date(r.first * 1000).getUTCMonth() + 1) + '. ' : ''}${hhmm(r.first)}</td><td class="num">${r.last == null ? '—' : ago(d.now - r.last)}</td></tr>`);
    if (sq) rows.push(`<tr class="mst-dim"><td>Squitter / II 0</td><td colspan="1">acquisition squitters (spontaneous) and replies to II 0</td><td class="num">${fmtRate(sq.rate)}</td><td class="num">${sq.n.toLocaleString('en')}</td><td colspan="3"></td></tr>`);
    table('mst-iid', [['Code', 'II = interrogator identifier (1–15), SI = surveillance identifier (1–63)'],
      ['Use', 'How codes with this value are allocated (ICAO EUR practice, EUROCONTROL MICA): 1–13 operational Mode S radars, 0 (SI 16 / 32 / 48) MLAT, WAM and mobile interrogators, 14 test and development, 15 military'],
      ['/s', 'Replies per second', 'num'],
      ['Replies', 'In the window', 'num'], ['Aircraft', 'Distinct aircraft that replied to it', 'num'],
      ['First', 'First heard (UTC; kept over restarts, from 25 Oct 2026)', 'num'], ['Last', 'Time since the last reply', 'num']], rows);
    const quiet = io.quiet.map(q => `${q.type} ${q.code} (last ${hhmm(q.last)})`).join(', ');
    const um = io.um.slice(0, 6).map(u => `IIS ${u.iis}/IDS ${u.ids}: ${u.n}`).join(' · ');
    $('mst-iid-foot').innerHTML = 'An all-call reply (DF11) carries the code of the Mode S interrogator that asked (an all-call '
      + 'with a code also locks out the aircraft it has already acquired, so the replies come mostly from aircraft new to that '
      + 'interrogator). Which code belongs to which site is not published, but a code that disappears or a new one shows a change. '
      + 'WAM interrogates selectively and usually needs no code (II 0). '
      + `Corrupted DF11: ${io.df11_bad}.`
      + (quiet ? `<br><b>Heard earlier, not in this window:</b> ${esc(quiet)}` : '')
      + (um ? `<br><span title="Utility message of the surveillance and Comm-B replies: IIS = the interrogator holding a reservation, IDS = its type (1 Comm-B, 2 Comm-C, 3 Comm-D)">Reservations (UM): ${esc(um)}</span>` : '');
  }

  // ── Radarcape receiver (its systemstatus.json, read by the server every 60 s) ─
  const dur = s => s == null ? '—' : s < 5400 ? ago(s) : s < 172800 ? (s / 3600).toFixed(1) + ' h' : Math.round(s / 86400) + ' d';
  const chip = (f, cls) => `<span class="mst-rc-chip ${cls}" title="${esc(f.text)}">${esc(f.flag)}</span>`;
  function distM(a, b, c, e) {
    const r = Math.PI / 180, x = (e - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
    return 6371000 * Math.hypot(x, y);
  }
  function renderRc(d) {
    const rc = d.radarcape, tb = $('mst-rc'), foot = $('mst-rc-foot');
    if (!tb) return;
    if (!rc || !rc.enabled) {
      tb.innerHTML = '<tbody><tr><td class="mst-empty">Not read (RADARCAPE_STATUS = False, or no RADARCAPE_HOST)</td></tr></tbody>';
      $('mst-rc-note').textContent = '';
      foot.innerHTML = 'The receiver\'s own status (systemstatus.json) is read once a minute when RADARCAPE_STATUS is on (the default).';
      return;
    }
    const x = rc.data;
    if (!x) {
      tb.innerHTML = `<tbody><tr><td class="mst-empty">${rc.err ? 'No answer from the Radarcape status yet' : 'Waiting for the first reading…'}</td></tr></tbody>`;
      $('mst-rc-note').textContent = '';
      foot.innerHTML = '';
      return;
    }
    const red = new Set(['AntFail', 'notTrack', 'noSync', 'PpsFail', 'TsipUbxFail']);
    const gps = (rc.gps_flags || []).map(f => chip(f, f.ok ? 'ok' : red.has(f.flag) ? 'err' : 'warn')).join('');
    const fpga = (rc.fpga_flags || []).map(f => chip(f, f.ok ? 'ok' : 'warn')).join('')
      + (rc.fpga_other || []).map(f => chip({ flag: f, text: 'other setting' }, '')).join('');
    const t = x.temp, tcls = t == null ? '' : t >= 85 ? 'mst-rc-err' : t >= 70 ? 'mst-rc-warn' : '';
    const rows = [];
    const row = (k, v, title) => rows.push(`<tr><td${title ? ` title="${esc(title)}"` : ''}>${k}</td><td>${v}</td></tr>`);
    row('GPS', `<span class="mst-rc-chips">${gps}</span>`, 'The GPS flags of the receiver (hover a flag): green as it should be, red a fault that spoils the timestamps (MLAT, the GPS quality monitor), amber a minor condition');
    row('GPS module', t == null ? '—' : `<span class="${tcls}">${fmt(t, 1)} °C</span> <span class="mst-dim2">(≈ ${fmt(t - 20, 0)} °C around it)</span>`
      + (rc.temp_min != null && rc.temp_n > 1 ? ` <span class="mst-dim2">· ${fmt(rc.temp_min, 0)}–${fmt(rc.temp_max, 0)} °C over ${rc.temp_n >= 1400 ? '24 h' : dur(rc.temp_n * 60)} (since the server started)</span>` : ''),
      'Temperature of the GPS module inside the receiver. It runs about 20 K above the air around it (Jetvision), so it is not the air temperature. Amber from 70 °C, red from 85 °C (about 50 / 65 °C around it)');
    const off = x.gps_time != null && x.sys_time != null ? x.sys_time - x.gps_time : null;
    row('Time', `timestamps ${esc(x.mlat_time_source || '?')} · system clock ${esc(x.ntp_source || '?')}`
      + (x.ntp_rms != null ? `, RMS offset ${x.ntp_rms} µs` : '')
      + (off != null ? ` · system − GPS ${off > 0 ? '+' : ''}${off} s` : ''),
      'Where the message timestamps and the receiver\'s system clock get their time (NTP RMS offset: the receiver\'s system clock against its time source, in microseconds)');
    row('Uptime', `receiver software ${dur(x.rcd_uptime)} · system ${dur(x.os_uptime)}`
      + (rc.restart_ts ? ` · <span class="mst-rc-warn">software restart seen ${hhmm(rc.restart_ts)} UTC</span>` : ''));
    const p = x.position, rg = d.range || {};
    if (p && p.lat != null) {
      let pos = `${Number(p.lat).toFixed(4)}° N ${Number(p.lon).toFixed(4)}° E`
        + (p.alt != null ? ` · ${fmt(p.alt, 0)} m` : '') + (p.live ? ' · live GPS fix' : ' · stored position');
      if (rg.site_src === 'radarcape') pos += ' <span class="mst-dim2">· centre of the range rings</span>';
      else pos += ` <span class="mst-rc-warn">· not used for the range rings${rg.site_rc_why ? ' (' + esc(rg.site_rc_why) + ')' : ''} — ${rg.site_src === 'config' ? 'ANTENNA_LAT / LON' : 'the map centre'} in use</span>`;
      if (rg.site_cfg && rg.site_cfg.length) {
        const m = distM(rg.site_cfg[0], rg.site_cfg[1], p.lat, p.lon);
        pos += ` <span class="mst-dim2">· ${m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km'} from ANTENNA_LAT / LON</span>`;
      }
      row('Position', pos, 'The receiver\'s GPS position and height (GPS height, about the height above sea level)');
    }
    row('Settings', `<span class="mst-rc-chips">${fpga}</span>`, 'Receiver (FPGA) settings that MODE-S Wind relies on (hover a setting); amber = differs from what this system expects');
    row('Versions', `${esc(x.sw_type || '')} software ${esc(x.sw_ver || '—')}<span class="mst-dim2"> · FPGA ${esc(x.fpga_ver || '—')}</span>`,
      `${x.board || ''}${x.distribution ? ', OS ' + x.distribution : ''}`);
    const fe = Object.entries(x.feeders || {}).map(([k, v]) => `${esc(k.replace(/_/g, ' '))} ${esc(String(v).replace(/^[a-z0-9]+_/i, ''))}`);
    const inet = Object.entries(x.internet || {});
    const on = inet.filter(([, v]) => String(v).toUpperCase() !== 'DISABLED');
    row('Feeders', (fe.length ? fe.join(', ') : 'none')
      + (inet.length ? ` <span class="mst-dim2">· online services ${on.length ? on.map(([k, v]) => esc(k.replace(/_/g, ' ')) + ' ' + esc(String(v).toLowerCase())).join(', ') : 'all off'}</span>` : ''));
    tb.innerHTML = '<tbody>' + rows.join('') + '</tbody>';
    const age = d.now - rc.ok_ts;
    $('mst-rc-note').textContent = `read ${ago(age)} ago` + (rc.err && rc.err_ts > rc.ok_ts ? ' · last try failed' : '');
    $('mst-rc-note').className = 'mst-hdr-note' + (age > 900 ? ' mst-rc-err' : age > 300 ? ' mst-rc-warn' : '');
    foot.innerHTML = 'The receiver\'s own status page (systemstatus.json), read by the server once a minute and kept in memory only. '
      + 'The GPS gives the receiver its nanosecond timestamps (MLAT and the GPS quality monitor depend on them): a red flag points to the antenna, its cable or the GPS module. '
      + 'Network details are not shown.';
  }

  function renderMeteo(d) {
    const m = d.meteo, s = d.window_sec / 60, j = d.json || {};
    const pairs = m.wind + m.wind_old + m.nowind;
    const st = Object.entries(j.stations || {}).sort((a, b) => a[0].localeCompare(b[0]));
    $('mst-meteo').innerHTML = '<table class="mst-table mst-kv"><tbody>'
      + `<tr><td title="New BDS 5,0 / 6,0 replies that completed a wind (with the other register within the pairing limit)">Winds computed</td><td class="num">${fmt(m.wind / s, 1)} /min</td><td class="num">${pct(m.wind, pairs)}</td></tr>`
      + `<tr><td title="… and with them a Mach/TAS temperature">with temperature</td><td class="num">${fmt(m.temp / s, 1)} /min</td><td></td></tr>`
      + `<tr><td title="The partner reply was older than WIND_MAX_AGE_SEC: the wind is not stored">Partner too old</td><td class="num">${fmt(m.wind_old / s, 1)} /min</td><td class="num">${pct(m.wind_old, pairs)}</td></tr>`
      + `<tr><td title="No partner within WIND_MAX_PAIR_AGE, or rejected by the checks (roll, track rate, speed)">No wind</td><td class="num">${fmt(m.nowind / s, 1)} /min</td><td class="num">${pct(m.nowind, pairs)}</td></tr>`
      + `<tr><td>MRAR (BDS 4,4) / MHR (BDS 4,5)</td><td class="num">${m.mrar} / ${m.mhr}</td><td></td></tr>`
      + `<tr class="mst-sep"><td>Aircraft list entries (last poll)</td><td class="num">${j.ts ? j.entries : '—'}</td><td class="num">${j.ts ? ago(d.now - j.ts) + ' ago' : ''}</td></tr>`
      + `<tr><td title="Positions in the list by source: multilateration by the Radarcape network / the aircraft's ADS-B">Positions MLAT / ADS-B</td><td class="num">${j.mlat ?? '—'} / ${j.adsb ?? '—'}</td><td></td></tr>`
      + `<tr><td>Polls / errors</td><td class="num">${j.polls ?? 0} / ${j.errors ?? 0}</td><td></td></tr>`
      + `<tr><td title="Blocked addresses (BLOCKED_ICAO_PREFIXES, e.g. T40… WAM ground stations) listed by the Radarcape">Ground stations listed</td><td class="num">${st.length}</td><td></td></tr>`
      + '</tbody></table>'
      + (st.length ? '<div class="mst-foot mst-stations">' + st.map(([k, v]) => `<span title="${esc(`source ${v.src || '?'}${v.alt != null ? ', altitude ' + v.alt + ' ft' : ''}; first ${hhmm(v.first)}, last ${hhmm(v.last)} UTC`)}">${esc(k)}${d.now - v.last > 300 ? ' (' + ago(d.now - v.last) + ')' : ''}</span>`).join(' ') + '</div>' : '');
  }

  // ── signal strength ───────────────────────────────────────────────────────
  const SIG_MIN_SHARE = 0.0005;      // a bin with at least 0.05 % of all frames is inside the receiver's range
  const SIG_NAME = { all: 'All frames', adsb: 'ADS-B (DF17/18)', reply: 'Replies (DF4/5, DF20/21)', df11: 'All-call (DF11)', acas: 'ACAS (DF0/16)', other: 'Other formats' };
  function renderSig(d) {
    const sg = d.signal || {}, cats = sg.cats || {};
    const all = cats.all;
    if (!all || !all.n) {
      if (sigChart) { sigChart.destroy(); sigChart = null; }
      const why = sg.state === 'off' ? 'Signal levels are switched off (MSG_STATS_SIGNAL = False in config.py).'
        : sg.state === 'unavailable' ? 'Signal levels are not available with this pyModeS version (its Beast parser was not found).'
        : 'No signal levels in the window yet.';
      table('mst-sig', [['Class']], []);
      $('mst-sig').querySelector('.mst-empty').textContent = why;
      $('mst-sig-note').textContent = '';
      $('mst-sig-foot').textContent = '';
      return;
    }
    const rows = ['all', 'adsb', 'reply', 'df11', 'acas', 'other'].filter(k => cats[k] && cats[k].n).map(k => {
      const c = cats[k];
      return `<tr class="mst-click${k === sigCat ? ' mst-sel' : ''}" data-cat="${k}"><td>${esc(SIG_NAME[k])}</td><td class="num">${c.n.toLocaleString('en')}</td>`
        + `<td class="num"><b>${fmt(c.median, 1)}</b></td><td class="num">${fmt(c.p10, 1)}</td><td class="num">${fmt(c.p90, 1)}</td>`
        + `<td class="num">${pct(c.strong, c.n)}</td></tr>`;
    });
    table('mst-sig', [['Class', 'Click a row to show it in the histogram'], ['Frames', 'Frames with a signal level in the window', 'num'],
      ['Median', 'Median signal level, dBFS', 'num'], ['p10', '10 % of the frames are weaker (dBFS)', 'num'],
      ['p90', '90 % of the frames are weaker (dBFS)', 'num'], ['≥ −3 dB', 'Share of frames within 3 dB of the top of the receiver range (strong, possibly clipped)', 'num']], rows);
    $('mst-sig').querySelectorAll('tr[data-cat]').forEach(tr => tr.addEventListener('click', () => setSigCat(tr.dataset.cat)));
    $('mst-sig-note').textContent = `median ${fmt(all.median, 1)} dBFS`;
    // Automatic range (from 2026-10-28): the byte allows −48 … 0 dBFS, but a receiver
    // reports only what passes its detection threshold (the Radarcape about −26 dBFS),
    // so the axis starts one bin below the weakest bin holding at least SIG_MIN_SHARE
    // of all frames and ends at 0 dBFS — the same range for every class, so the axis
    // does not jump when another class is chosen.
    const nAll = all.hist.reduce((a, b) => a + b, 0) || 1;
    let iw = all.hist.findIndex(v => v >= nAll * SIG_MIN_SHARE);
    if (iw < 0) iw = 0;
    const i0 = Math.max(0, iw - 1);
    const weakDb = sg.lo_db + sg.step_db * iw;
    const below = all.hist.slice(0, i0).reduce((a, b) => a + b, 0);
    const dbs = v => String(v).replace('-', '−');
    $('mst-sig-foot').innerHTML = 'The level is the Beast signal byte of each frame, the receiver\'s peak amplitude of the reply, '
      + `shown as dBFS = 20·log₁₀(byte / 255): 0 dBFS is the top of its range; the weakest replies this receiver reports are about ${dbs(weakDb)} dBFS `
      + '(its detection threshold), and the chart starts just below them. '
      + 'It is not calibrated in dBm, but it is consistent for this receiver, so the shape and its changes are what count: '
      + 'the weak tail is the edge of the coverage (distant aircraft, low-elevation shadows), the strong end nearby aircraft '
      + 'and ground traffic; a strong-end share that grows can mean an overloaded front end. Replies to the ground interrogators '
      + '(DF4/5/20/21, DF11) and ADS-B come from the same transponder, so the classes differ mainly through where the aircraft are when they send.'
      + (below ? ` ${below.toLocaleString('en')} stray frame${below === 1 ? '' : 's'} below ${dbs(sg.lo_db + sg.step_db * i0)} dBFS not shown.` : '')
      + (sg.zero ? ` Frames with no level: ${sg.zero}.` : '')
      + (sg.parser && (sg.parser.skipped || sg.parser.misaligned) ? ` Bursts without levels (parser check): ${(sg.parser.skipped || 0) + (sg.parser.misaligned || 0)}.` : '');
    // chart
    if (typeof Chart === 'undefined') return;
    const c = cats[sigCat] && cats[sigCat].n ? cats[sigCat] : all;
    const lbl = c.hist.slice(i0).map((_, i) => dbs(sg.lo_db + sg.step_db * (i0 + i)));
    const share = h => { const n = h.reduce((a, b) => a + b, 0) || 1; return h.slice(i0).map(v => +(100 * v / n).toFixed(2)); };
    const sets = [{ type: 'bar', label: SIG_NAME[cats[sigCat] && cats[sigCat].n ? sigCat : 'all'], data: share(c.hist), backgroundColor: css('--accent'), borderWidth: 0, barPercentage: 1, categoryPercentage: 0.92 }];
    if (c !== all) sets.push({ type: 'line', label: 'All frames', data: share(all.hist), borderColor: css('--text-3'), borderWidth: 1.2, pointRadius: 0, tension: 0.25 });
    const grid = css('--border'), txt = css('--text-2');
    const cfg = {
      type: 'bar', data: { labels: lbl, datasets: sets },
      options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: sets.length > 1, labels: { color: txt, boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { title: it => `${lbl[it[0].dataIndex]} … ${dbs(sg.lo_db + sg.step_db * (i0 + it[0].dataIndex + 1))} dBFS`,
            label: x => `${x.dataset.label}: ${x.parsed.y} %` } } },
        scales: { x: { title: { display: true, text: 'dBFS', color: txt, font: { size: 10 } }, ticks: { color: txt, maxRotation: 0, autoSkip: true, maxTicksLimit: 13, font: { size: 10 } }, grid: { display: false } },
                  y: { beginAtZero: true, title: { display: true, text: '% of frames', color: txt, font: { size: 10 } }, ticks: { color: txt, font: { size: 10 } }, grid: { color: grid } } } },
    };
    if (sigChart) { sigChart.data = cfg.data; sigChart.options = cfg.options; sigChart.update('none'); }
    else sigChart = new Chart($('mst-sig-chart'), cfg);
  }
  function setSigCat(k) {
    sigCat = k;
    const sel = $('mst-sig-cat'); if (sel) sel.value = k;
    try { localStorage.setItem('ms_statsSig', k); } catch (e) { /* */ }
    if (data) renderSig(data);
  }

  // ── range rings ───────────────────────────────────────────────────────────
  const BAND_NAME = { high: 'FL250 and above', mid: 'FL100–FL245', low: 'below FL100' };
  let polarGeom = null;
  function renderRange(d) {
    const rg = d.range || {}, mx = rg.max || {}, nsec = rg.sectors || 36;
    const cv = $('mst-polar');
    const w = Math.round(cv.getBoundingClientRect().width) || 300;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = w * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, w);
    let far = 0;
    for (const b in mx) for (const x of mx[b]) if (x && x[0] > far) far = x[0];
    const step = far > 260 ? 100 : 50;
    const outer = Math.max(100, Math.ceil(far / step) * step);
    const cx = w / 2, cy = w / 2, R = w / 2 - 18;
    const k = R / outer;
    polarGeom = { cx, cy, R, k, nsec, outer };
    const grid = css('--border'), txt = css('--text-3');
    g.font = '10px system-ui, sans-serif';
    // sectors (high first, the lower bands on top)
    const COL = { high: css('--accent'), mid: css('--green'), low: css('--amber') };
    for (const b of ['high', 'mid', 'low']) {
      const sec = mx[b]; if (!sec) continue;
      g.fillStyle = COL[b];
      for (let i = 0; i < nsec; i++) {
        const x = sec[i]; if (!x) continue;
        const a0 = (i * 360 / nsec - 90) * Math.PI / 180, a1 = ((i + 1) * 360 / nsec - 90) * Math.PI / 180;
        g.globalAlpha = 0.33;
        g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, x[0] * k, a0, a1); g.closePath(); g.fill();
        g.globalAlpha = 0.95;
        g.strokeStyle = COL[b]; g.lineWidth = 1.6;
        g.beginPath(); g.arc(cx, cy, x[0] * k, a0, a1); g.stroke();
      }
    }
    g.globalAlpha = 1;
    // rings and spokes
    g.strokeStyle = grid; g.lineWidth = 1; g.fillStyle = txt;
    for (let r = step; r <= outer; r += step) {
      g.beginPath(); g.arc(cx, cy, r * k, 0, 2 * Math.PI); g.stroke();
      const a = -Math.PI / 4;
      const lx = cx + r * k * Math.cos(a) + 2, ly = cy + r * k * Math.sin(a) - 2;
      g.lineWidth = 3; g.strokeStyle = css('--bg-1'); g.strokeText(`${r}`, lx, ly);
      g.lineWidth = 1; g.strokeStyle = grid; g.fillText(`${r}`, lx, ly);
    }
    for (let deg = 0; deg < 360; deg += 30) {
      const a = (deg - 90) * Math.PI / 180;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a)); g.stroke();
    }
    g.fillStyle = css('--text-2'); g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, deg]) => {
      const a = (deg - 90) * Math.PI / 180;
      g.fillText(t, cx + (R + 9) * Math.cos(a), cy + (R + 9) * Math.sin(a));
    });
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    g.fillStyle = css('--text-1'); g.beginPath(); g.arc(cx, cy, 2.5, 0, 2 * Math.PI); g.fill();
    // table
    const rows = (rg.rows || []);
    const tot = rows.reduce((a, r) => a + r.pos, 0);
    const out = EMBED
      ? rows.map(r => `<tr><td class="num">${r.lo}–${r.hi == null ? '' : r.hi}${r.hi == null ? '+' : ''}</td><td class="num">${r.pos.toLocaleString('en')}</td>`
          + `<td class="num">${pct(r.pos, tot)}</td><td class="num">${r.ac}</td><td class="num">${fmt(r.sig_median, 1)}</td></tr>`)
      : rows.map(r => `<tr><td>${r.lo}–${r.hi == null ? '' : r.hi} NM${r.hi == null ? '+' : ''}</td><td class="num">${r.pos.toLocaleString('en')}</td>`
      + `<td class="num">${pct(r.pos, tot)}</td><td>${bar(tot ? r.pos / tot : 0, 'mst-fill-b')}</td><td class="num">${r.ac}</td>`
      + `<td class="num">${fmt(r.sig_median, 1)}</td><td class="num">${fmt(r.sig_p10, 1)}</td></tr>`);
    if (EMBED) table('mst-rng', [['NM', 'Distance from the antenna', 'num'], ['Positions', 'Accepted ADS-B airborne positions', 'num'], ['Share', '', 'num'],
      ['Aircraft', 'Distinct aircraft with a position in the band', 'num'], ['Signal', 'Median signal level of those position messages, dBFS', 'num']], out);
    else table('mst-rng', [['Range', 'Distance from the antenna'], ['Positions', 'Accepted ADS-B airborne positions', 'num'], ['Share', '', 'num'], [''],
      ['Aircraft', 'Distinct aircraft with a position in the band', 'num'], ['Signal', 'Median signal level of those position messages, dBFS', 'num'],
      ['p10', '10 % of them are weaker (dBFS)', 'num']], out);
    const f = rg.farthest;
    $('mst-rng-note').textContent = f ? `farthest ${fmt(f.nm, 0)} NM at ${String(f.brg).padStart(3, '0')}°` : '';
    $('mst-rng-note').title = f ? `${f.icao}${f.alt != null ? ', ' + f.alt.toLocaleString('en') + ' ft' : ''}` : '';
    const leg = ['high', 'mid', 'low'].map(b => `<span class="mst-legend"><i style="background:${COL[b]}"></i>${BAND_NAME[b]}</span>`).join('');
    const site = rg.site || [];
    $('mst-rng-foot').innerHTML = leg + '<br>The farthest accepted position in each 10° sector, by altitude band, from the antenna '
      + `(${site.length ? site[0].toFixed(3) + '° N ' + site[1].toFixed(3) + '° E' : '—'}${rg.site_alt != null ? ', ' + fmt(rg.site_alt, 0) + ' m' : ''}; `
      + `${{ radarcape: 'the Radarcape\'s own GPS position' + (rg.site_cfg ? ', ANTENNA_LAT / ANTENNA_LON as the fallback' : ''),
             config: 'ANTENNA_LAT / ANTENNA_LON in config.py' + (rg.site_rc_why ? ' — the Radarcape\'s GPS position not used: ' + rg.site_rc_why : ''),
             centre: 'the map centre — the Radarcape\'s GPS position not available; ANTENNA_LAT / ANTENNA_LON in config.py would be the fallback' }[rg.site_src] || 'ANTENNA_LAT / ANTENNA_LON in config.py'}); `
      + `rings every ${step} NM. Only positions decoded from our own reception count, and only when they fit the aircraft's previous position, `
      + 'so a single bad decode cannot make a record. The shape shows the horizon (higher aircraft are seen farther) and the shadows of nearby terrain and buildings; '
      + `a sector that shrinks at all levels suggests the antenna or its cable. ${EMBED ? 'Tap' : 'Hover'} a sector for its values.`
      + ` Positions ${(rg.n || 0).toLocaleString('en')} · rejected jumps ${rg.jumps || 0} · beyond ${rg.max_nm || 400} NM ${rg.far_rejected || 0}.`;
  }
  function polarHover(ev) {
    const tip = $('mst-polar-tip');
    if (!data || !polarGeom) return;
    const cv = $('mst-polar'), rect = cv.getBoundingClientRect();
    const x = ev.clientX - rect.left - polarGeom.cx, y = ev.clientY - rect.top - polarGeom.cy;
    const dist = Math.hypot(x, y) / polarGeom.k;
    if (dist > polarGeom.outer * 1.02) { tip.style.display = 'none'; return; }
    const brg = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
    const i = Math.floor(brg / (360 / polarGeom.nsec)) % polarGeom.nsec;
    const mx = (data.range || {}).max || {};
    const lines = ['high', 'mid', 'low'].map(b => {
      const v = mx[b] && mx[b][i];
      return `${BAND_NAME[b]}: ${v ? `<b>${fmt(v[0], 0)} NM</b> (${esc(v[2])}${v[1] != null ? ', ' + v[1].toLocaleString('en') + ' ft' : ''})` : '—'}`;
    });
    const s0 = i * 360 / polarGeom.nsec;
    tip.innerHTML = `<b>${String(s0).padStart(3, '0')}–${String(s0 + 360 / polarGeom.nsec).padStart(3, '0')}°</b> · cursor ${fmt(dist, 0)} NM<br>` + lines.join('<br>');
    tip.style.display = 'block';
    const wrap = cv.parentElement.getBoundingClientRect();
    let left = ev.clientX - wrap.left + 12, top = ev.clientY - wrap.top + 12;
    if (left + tip.offsetWidth > wrap.width - 4) left = ev.clientX - wrap.left - tip.offsetWidth - 12;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }

  // ── system health ─────────────────────────────────────────────────────────
  const ST_NAME = { ok: 'Healthy', warn: 'Degraded', err: 'Fault', off: 'Off' };
  const dot = st => `<i class="mst-hl-dot st-${st}"></i>`;
  const forDur = s => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} d`;
  function renderHealth(h) {
    if (!h) return;
    if (EMBED) { if ($('mst-hl-panel')) renderHealthPanel(); return; }   // the phone: the panel inline
    $('mst-hl-dots').innerHTML = h.items.map(i => `<span class="mst-hl" title="${esc(i.label + ' — ' + ST_NAME[i.state] + ': ' + i.text)}">${dot(i.state)}${esc(i.label)}</span>`).join('');
    const c = h.counts, act = h.items.length - c.off;
    const txt = h.overall === 'err' ? `${c.err} fault${c.err > 1 ? 's' : ''}`
      : h.overall === 'warn' ? `${c.warn} warning${c.warn > 1 ? 's' : ''}` : `Healthy ${c.ok}/${act}`;
    $('mst-hl-chip').innerHTML = `${dot(h.overall)}<span>${esc(txt)}</span>`;
    const bad = h.items.filter(i => i.state === 'err' || i.state === 'warn');
    $('mst-health').title = 'System health — ' + (bad.length ? bad.map(i => `${i.label}: ${i.text}`).join(' · ') : 'all parts working') + ' (click for details)';
    if (!$('mst-hl-panel').hidden) renderHealthPanel();
  }
  function renderHealthPanel() {
    const h = health, p = $('mst-hl-panel');
    if (!h) { p.innerHTML = '<div class="mst-hl-foot">Loading…</div>'; return; }
    const rows = h.items.map(i => `<tr><td>${dot(i.state)}</td><td class="mst-hl-name" title="${esc(i.title)}">${esc(i.label)}</td>`
      + `<td>${esc(i.text)}${i.detail && i.detail.length ? `<span class="mst-hl-det">${esc(i.detail.join(' · '))}</span>` : ''}</td>`
      + `<td class="mst-hl-since" title="In this state since ${hhmm(i.since)} UTC">${ST_NAME[i.state]}<br>${forDur(h.now - i.since)}</td></tr>`).join('');
    const ch = h.changes.length ? h.changes.slice(0, 12).map(x => `<div class="mst-hl-ch"><span>${hhmm(x.ts)}</span>${dot(x.from)}→${dot(x.to)}<b>${esc(x.label)}</b><span>${esc(x.text)}</span></div>`).join('')
      : `<div class="mst-hl-ch">No changes since the server started (${hhmm(h.started)} UTC).</div>`;
    p.innerHTML = `<div class="mst-hl-head">${dot(h.overall)} System health <small>· checked ${hhmm(h.now)} UTC · server running ${forDur(h.now - h.started)}</small>`
      + `<button class="mst-hl-x" title="Close" aria-label="Close">×</button></div>`
      + `<table><tbody>${rows}</tbody></table>`
      + `<div class="mst-hl-sub">Recent changes</div>${ch}`
      + '<div class="mst-hl-foot">Green: working normally · amber: working but late, retrying or on a fallback (e.g. the stored calibration when there is no new model data) · '
      + 'red: stopped, failing or out of date · grey ring: switched off in config.py, or an optional file not installed. MEPS and the registration database (Reg. DB) are optional, so they are never red. '
      + 'Checked every 10 s while the page is open and every minute in the background; the details of errors are in the server log.</div>';
    if (EMBED) { const x = p.querySelector('.mst-hl-x'); if (x) x.remove(); return; }
    p.querySelector('.mst-hl-x').addEventListener('click', ev => { ev.stopPropagation(); toggleHealth(false); });
  }
  function toggleHealth(open) {
    const p = $('mst-hl-panel');
    p.hidden = !(open ?? p.hidden);
    $('mst-health').setAttribute('aria-expanded', String(!p.hidden));
    if (!p.hidden) renderHealthPanel();
  }
  async function pollHealth() {
    try {
      const r = await fetch('/api/health');
      if (!r.ok) return;
      health = await r.json();
      renderHealth(health);
    } catch (e) { /* next poll */ }
  }

  // ── chart ─────────────────────────────────────────────────────────────────
  function chartData(d) {
    // 7 d: the 10-min means of the stored minutes (same units as the 24 h)
    const tr = range === '7d' && d.trend_week ? d.trend_week : d.trend;
    const keys = tr.keys, rows = tr.rows;
    const col = k => keys.indexOf(k);
    const sel = range === '1h' ? rows.slice(-60) : rows;
    const dm = t => { const x = new Date(t * 1000); return `${x.getUTCDate()}.${x.getUTCMonth() + 1}. `; };
    const lbl = range === '7d' ? r => dm(r[0]) + hhmm(r[0]) : r => hhmm(r[0]);
    const per = k => sel.map(r => r[col(k)] == null ? null : +(r[col(k)] / 60).toFixed(2));
    const per2 = (a, b) => sel.map(r => r[col(a)] == null ? null : +((r[col(a)] + r[col(b)]) / 60).toFixed(2));
    const raw = k => sel.map(r => r[col(k)]);
    const C = [css('--accent'), css('--green'), css('--amber'), css('--purple') || '#8b5cf6', css('--red')];
    if (series === 'rate' && range === '1h') {
      const ten = d.ten.slice(-360);
      return { labels: ten.map(t => hhmm(t[0])), sets: [['Messages/s', ten.map(t => t[1] == null ? null : t[1] / 10), C[0]]], unit: '/s' };
    }
    const L = sel.map(lbl);
    switch (series) {
      case 'formats': return { labels: L, unit: '/s', sets: [
        ['DF4/5', per2('df4', 'df5'), C[0]], ['DF11', per('df11'), C[3]],
        ['DF17', per('df17'), C[1]], ['DF20/21', per2('df20', 'df21'), C[2]]] };
      case 'regs': return { labels: L, unit: '/s', sets: [['BDS 5,0', per('bds50'), C[0]], ['BDS 6,0', per('bds60'), C[1]],
        ['BDS 4,0', per('bds40'), C[2]], ['BDS 2,0', per('bds20'), C[3]]] };
      case 'aircraft': return { labels: L, unit: '', sets: [['Aircraft', raw('ac'), C[0]], ['EHS aircraft', raw('ehs'), C[1]]] };
      case 'cad': return { labels: L, unit: 's', sets: [['Final', raw('cad50_final'), C[4]], ['Terminal', raw('cad50_term'), C[2]],
        ['En route', raw('cad50_enr'), C[0]]] };
      case 'iid': return { labels: L, unit: '', sets: [['Interrogator codes heard', raw('iid_n'), C[3]]] };
      default: return { labels: L, unit: '/s', sets: [['Messages/s', per('msgs'), C[0]]] };
    }
  }

  // ── Data transfer (collector/traffic.py, /api/traffic; from 2026-10-27) ──
  const fmtB = (b, d) => {
    if (b == null) return '—';
    const u = [['GB', 1e9], ['MB', 1e6], ['kB', 1e3]];
    for (const [n, f] of u) if (Math.abs(b) >= f) return (b / f).toFixed(d != null ? d : (b / f >= 100 ? 0 : b / f >= 10 ? 1 : 2)) + ' ' + n;
    return Math.round(b) + ' B';
  };
  const fmtRateB = v => v == null ? '—' : v >= 1e6 ? (v / 1e6).toFixed(2) + ' MB/s' : (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + ' kB/s';
  // the summary table above the chart: one row per period
  function trRow(name, x, perSec, title) {
    const n = v => perSec ? fmtRateB(v) : fmtB(v);
    if (!x || (!perSec && !x.hours)) return `<tr><th>${esc(name)}</th><td colspan="4" class="mst-tr-none">no data yet</td></tr>`;
    const tip = `Beast stream ${n(x.beast)} · aircraft list ${n(x.json)} · receiver status ${n(x.status)}`;
    const net = trData.iface_ok;
    return `<tr${title ? ` title="${esc(title)}"` : ''}><th>${esc(name)}</th>` +
      `<td title="${esc(tip)}">${n(x.app_in)}</td><td>${n(x.web)}</td>` +
      `<td>${net ? n(x.rx) : '—'}</td><td>${net ? n(x.tx) : '—'}</td></tr>`;
  }
  function renderTrafficSum() {
    const el = $('mst-tr-sum');
    if (!trData) { el.innerHTML = ''; return; }
    const t = trData;
    const rows = [
      trRow('Now (per second)', t.rate && t.rate.app_in != null ? t.rate : null, true, 'The last full minute'),
      trRow('Today (UTC)', t.today), trRow('Yesterday', t.yesterday), trRow('Last 7 days', t.last7),
      trRow(`${t.month_label}`, t.month, false, `The month so far (UTC; counted ${t.month_counted_h} h)`),
      t.month_projection ? trRow('≈ whole month', Object.assign({ hours: 1 }, t.month_projection), false,
        `${t.month_label} at the rate of the ${t.month_counted_h} h counted so far, scaled to the whole month`) : '',
    ].join('');
    el.innerHTML = `<table class="mst-table mst-tr-table"><thead><tr><th></th>` +
      `<th title="The Beast stream, the aircraft list and the status page received from the receiver (hover a value for the parts)">From receiver</th>` +
      `<th title="The web pages and data sent to the users (bodies and headers; the Live Map's live stream included)">Served to users</th>` +
      `<th title="Everything the network interface${t.iface ? ' (' + esc(t.iface) + ')' : ''} received: also the encryption overhead, HTTPS, model / sounding / METAR downloads and system updates">Interface ↓</th>` +
      `<th title="Everything the network interface sent">Interface ↑</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function trChartData() {
    const t = trData, keys = ['t'].concat(t.kinds), col = k => keys.indexOf(k);
    const bins = t.bins || [];
    const dm = x => `${x.getUTCDate()}.${x.getUTCMonth() + 1}.`;
    const lbl = t.bin_sec === 86400 ? b => dm(new Date(b[0] * 1000))
      : t.bin_sec === 3600 && range === '7d' ? b => dm(new Date(b[0] * 1000)) + ' ' + hhmm(b[0]) : b => hhmm(b[0]);
    const C = [css('--accent'), css('--green'), css('--purple') || '#8b5cf6', css('--amber'), css('--red')];
    const v = k => bins.map(b => b[col(k)]);
    const sets = trView === 'net'
      ? [['Received (interface)', v('rx'), C[0], 'in'], ['Sent (interface)', v('tx'), C[3], 'out']]
      : [['Beast stream', v('beast'), C[0], 'in'], ['Aircraft list', v('json'), C[1], 'in'],
         ['Receiver status', v('status'), C[2], 'in'], ['Web pages served', v('web'), C[3], 'out']];
    let max = 0;
    bins.forEach((b, i) => { const s = { in: 0, out: 0 }; sets.forEach(x => { s[x[3]] += x[1][i] || 0; }); max = Math.max(max, s.in, s.out); });
    const [unit, f] = max >= 2e9 ? ['GB', 1e9] : max >= 2e6 ? ['MB', 1e6] : ['kB', 1e3];
    const per = t.bin_sec === 60 ? 'minute' : t.bin_sec === 3600 ? 'hour' : 'day';
    return { labels: bins.map(lbl), unit, per, binSec: t.bin_sec,
             sets: sets.map(([l, vals, c, st]) => [l, vals.map(x => x == null ? null : +(x / f).toFixed(3)), c, st]) };
  }
  function renderTrafficChart() {
    if (typeof Chart === 'undefined' || !trData) return;
    const cd = trChartData();
    const grid = css('--border'), txt = css('--text-2');
    const cfg = {
      type: 'bar',
      data: { labels: cd.labels, datasets: cd.sets.map(([label, vals, color, stack]) => ({
        label, data: vals, backgroundColor: color, borderWidth: 0, stack, barPercentage: 0.95, categoryPercentage: 0.9 })) },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, labels: { color: txt, boxWidth: 12, font: { size: 11 } } },
                   tooltip: { callbacks: {
                     label: c => c.parsed.y == null ? `${c.dataset.label}: —`
                       : `${c.dataset.label}: ${c.parsed.y} ${cd.unit} (${fmtRateB(c.parsed.y * (cd.unit === 'GB' ? 1e9 : cd.unit === 'MB' ? 1e6 : 1e3) / cd.binSec)})` } } },
        scales: { x: { stacked: true, ticks: { color: txt, maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, grid: { color: grid } },
                  y: { stacked: true, beginAtZero: true, title: { display: true, text: `${cd.unit} per ${cd.per}`, color: txt, font: { size: 10 } },
                       ticks: { color: txt, font: { size: 10 } }, grid: { color: grid } } },
      },
    };
    if (chart && chartType === 'bar') { chart.data = cfg.data; chart.options = cfg.options; chart.update('none'); }
    else { if (chart) chart.destroy(); chart = new Chart($('mst-chart'), cfg); chartType = 'bar'; }
  }
  function setTab(t) {
    tab = t;
    try { localStorage.setItem('ms_statsTab', tab); } catch (e) { /* */ }
    document.querySelectorAll('#mst-chart-tabs .mst-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const tr = tab === 'traffic';
    document.querySelectorAll('#mst-chart-range .mst-tr-only').forEach(b => { b.hidden = !tr; });
    $('mst-tr-view').hidden = !tr;
    $('mst-chart-series').hidden = tr;
    $('mst-tr-sum').hidden = !tr;
    if (!tr && range === '30d') {
      range = '7d';
      document.querySelectorAll('#mst-chart-range .gps-range-btn').forEach(x => x.classList.toggle('active', x.dataset.range === range));
    }
  }

  function renderChart(d) {
    if (typeof Chart === 'undefined') return;
    if (tab === 'traffic') { renderTrafficSum(); renderTrafficChart(); return; }
    const cd = chartData(d);
    const grid = css('--border'), txt = css('--text-2');
    const cfg = {
      type: 'line',
      data: { labels: cd.labels, datasets: cd.sets.map(([label, vals, color]) => ({
        label, data: vals, borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: 0, spanGaps: false, tension: 0.2 })) },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: cd.sets.length > 1, labels: { color: txt, boxWidth: 12, font: { size: 11 } } },
                   tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? '—' : c.parsed.y}${cd.unit ? ' ' + cd.unit : ''}` } } },
        scales: { x: { ticks: { color: txt, maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }, grid: { color: grid } },
                  y: { beginAtZero: true, ticks: { color: txt, font: { size: 10 } }, grid: { color: grid } } },
      },
    };
    if (chart && chartType === 'line') { chart.data = cfg.data; chart.options = cfg.options; chart.update('none'); }
    else { if (chart) chart.destroy(); chart = new Chart($('mst-chart'), cfg); chartType = 'line'; }
  }

  // ── polling ───────────────────────────────────────────────────────────────
  function renderAll() {
    if (!data) return;
    const parts = [renderBar, renderDf, renderBds, renderTc, renderCad, renderIid, renderRc, renderSig, renderRange, renderMeteo, renderChart];
    for (const f of parts) { try { f(data); } catch (e) { console.error('stats', f.name, e); } }
    fitIid();
  }
  // The Interrogators panel (middle column) ends level with the Meteo yield
  // panel (left column) when the two columns stand side by side; the rest of
  // its table and notes scroll inside it.  Stacked (one column): full height.
  function fitIid() {
    const sc = $('mst-iid-scroll'), ip = $('mst-iid-panel'), mp = $('mst-meteo-panel');
    if (!sc || !ip || !mp) return;
    const top = sc.scrollTop;
    sc.style.maxHeight = '';
    const ic = ip.parentElement, mc = mp.parentElement;
    if (ic === mc || ic.offsetLeft === mc.offsetLeft || Math.abs(ic.offsetTop - mc.offsetTop) > 2) return;
    const target = mp.getBoundingClientRect().bottom;
    if (ip.getBoundingClientRect().bottom <= target + 1) return;           // fits as it is
    const room = target - sc.getBoundingClientRect().top - 1;              // 1 px: the panel's bottom border
    sc.style.maxHeight = Math.max(160, Math.floor(room)) + 'px';
    sc.scrollTop = top;
  }
  async function poll() {
    clearTimeout(timer);
    if (document.hidden || !active) return;
    pollHealth();
    try {
      const wk = range === '7d' && tab === 'msgs';
      const r = await fetch('/api/msgstats?window=' + win + (wk ? '&trend=7d' : ''));
      data = await r.json();
      if (tab === 'traffic') await pollTraffic(false);
      renderAll();
    } catch (e) {
      if ($('mst-updated')) $('mst-updated').textContent = 'Update failed — retrying';
    }
    timer = setTimeout(poll, POLL_MS);
  }

  async function pollTraffic(render) {
    try {
      const r = await fetch('/api/traffic?range=' + encodeURIComponent(range));
      trData = await r.json();
    } catch (e) { /* the next poll tries again */ }
    if (render) renderChart(data);
  }

  function initButtons() {
    document.querySelectorAll('#mst-chart-tabs .mst-tab').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.tab === tab) return;
      setTab(b.dataset.tab);
      if (tab === 'traffic') pollTraffic(true);
      else if (range === '7d' && !(data && data.trend_week)) poll();
      else if (data) renderChart(data);
    }));
    const tv = $('mst-tr-view');
    tv.value = trView;
    tv.addEventListener('change', () => { trView = tv.value; try { localStorage.setItem('ms_statsTrView', trView); } catch (e) { /* */ } renderChart(data); });
    setTab(tab);
    document.querySelectorAll('#mst-win-btns .gps-zone-btn').forEach(b => {
      b.classList.toggle('active', +b.dataset.win === win);
      b.addEventListener('click', () => {
        win = +b.dataset.win;
        try { localStorage.setItem('ms_statsWindow', String(win)); } catch (e) { /* */ }
        document.querySelectorAll('#mst-win-btns .gps-zone-btn').forEach(x => x.classList.toggle('active', x === b));
        poll();
      });
    });
    document.querySelectorAll('#mst-chart-range .gps-range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    document.querySelectorAll('#mst-chart-range .gps-range-btn').forEach(b => b.addEventListener('click', () => {
      range = b.dataset.range;
      document.querySelectorAll('#mst-chart-range .gps-range-btn').forEach(x => x.classList.toggle('active', x === b));
      if (tab === 'traffic') pollTraffic(true);
      else if (range === '7d' && !(data && data.trend_week)) poll();     // the 7 d series is sent only when asked for
      else if (data) renderChart(data);
    }));
    const s = $('mst-chart-series');
    s.value = series;
    s.addEventListener('change', () => { series = s.value; try { localStorage.setItem('ms_statsSeries', series); } catch (e) { /* */ } if (data) renderChart(data); });
    const k = $('mst-cad-kind');
    k.value = cadKind;
    k.addEventListener('change', () => { cadKind = k.value; try { localStorage.setItem('ms_statsCad', cadKind); } catch (e) { /* */ } if (data) renderCad(data); });
    const sc = $('mst-sig-cat');
    sc.value = sigCat;
    sc.addEventListener('change', () => setSigCat(sc.value));
    const hl = $('mst-health');
    if (hl && !EMBED) {
      hl.addEventListener('click', ev => { ev.stopPropagation(); toggleHealth(); });
      hl.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleHealth(); } });
      $('mst-hl-panel').addEventListener('click', ev => ev.stopPropagation());
      document.addEventListener('click', () => { if (!$('mst-hl-panel').hidden) toggleHealth(false); });
      document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('mst-hl-panel').hidden) toggleHealth(false); });
    }
    const pv = $('mst-polar');
    let tapTip = false;                                      // a tap on a phone keeps its read-out
    pv.addEventListener('mousemove', ev => { if (!tapTip) polarHover(ev); });
    pv.addEventListener('pointerdown', ev => { tapTip = ev.pointerType !== 'mouse'; polarHover(ev); });
    pv.addEventListener('mouseleave', () => { if (!tapTip) $('mst-polar-tip').style.display = 'none'; });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (data) { renderRange(data); fitIid(); } }, 150); });
  }

  window.onThemeChange = () => {
    if (chart) { chart.destroy(); chart = null; chartType = null; }
    if (sigChart) { sigChart.destroy(); sigChart = null; }
    if (data) { renderChart(data); renderSig(data); renderRange(data); }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) poll(); });
  initButtons();
  if (EMBED) {
    // the mobile view drives the polling: only while its Statistics view is shown
    window.MsStats = {
      start() { active = true; poll(); },
      stop() { active = false; clearTimeout(timer); },
      setWindow(w) { win = +w; if (active) poll(); },
      redraw() { if (data) { renderRange(data); renderChart(data); renderSig(data); } },
    };
  } else poll();
})();
