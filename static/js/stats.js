/**
 * stats.js — Mode S & ADS-B Statistics page (from 2026-10-25).
 *
 * Polls /api/msgstats every 10 s (not while the tab is hidden) and draws:
 * the summary bar, the message-rate chart (1 h every 10 s, or 24 h per
 * minute with a choice of series), the downlink formats, the Comm-B
 * registers, the ADS-B type codes, the reply cadence per flight phase, the
 * interrogators of the DF11 all-call replies, the meteo yield and the
 * Radarcape aircraft list.  The window (1 min / 10 min / 1 h) is remembered
 * in the browser.
 */
(function () {
  'use strict';
  const POLL_MS = 10000;
  let win = 10, range = '1h', series = 'rate', cadKind = '5,0';
  try {
    win = parseInt(localStorage.getItem('ms_statsWindow') || '10', 10) || 10;
    series = localStorage.getItem('ms_statsSeries') || 'rate';
    cadKind = localStorage.getItem('ms_statsCad') || '5,0';
  } catch (e) { /* private mode */ }
  let data = null, chart = null, timer = null;

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
    const ten = d.ten || [];
    const last = ten.length ? ten[ten.length - 1][1] / 10 : null;
    $('mst-k-rate').textContent = last == null ? '—' : fmtRate(last);
    $('mst-k-rate').title = `Last 10 s: ${last == null ? '—' : fmtRate(last)} /s · window average ${fmtRate(d.totals.rate)} /s`;
    $('mst-k-ac').textContent = d.totals.aircraft;
    $('mst-k-adsb').textContent = d.totals.adsb;
    $('mst-k-ehs').textContent = d.totals.ehs;
    $('mst-k-ehsnow').textContent = `${d.totals.ehs_now} / ${d.totals.ehs_silent}`;
    const j = d.json || {};
    $('mst-k-mlat').textContent = j.ts ? `${j.mlat} / ${j.adsb}` : '—';
    const f = d.feed;
    const age = f.last_msg_ts ? d.now - f.last_msg_ts : null;
    const el = $('mst-k-feed');
    el.textContent = age == null ? 'no data' : age < 5 ? 'live' : `silent ${ago(age)}`;
    el.className = 'gps-summary-val ' + (age != null && age < 5 ? 'mst-ok' : 'mst-warn');
    el.title = `Last frame ${ago(age)} ago · connected ${f.connected_ts ? ago(d.now - f.connected_ts) : '—'} · `
      + `${f.connects} connection(s) since the server started (${hhmm(f.started)} UTC) · ${f.total_msgs.toLocaleString('en')} frames in all`;
    $('mst-updated').textContent = `Updated ${hhmm(d.now)}:${String(new Date(d.now * 1000).getUTCSeconds()).padStart(2, '0')} UTC · window ${Math.round(d.window_sec / 60)} min`;
  }

  // ── tables ────────────────────────────────────────────────────────────────
  function table(id, head, rows) {
    $(id).innerHTML = '<thead><tr>' + head.map(h => `<th${h[1] ? ` title="${esc(h[1])}"` : ''}${h[2] ? ` class="${h[2]}"` : ''}>${h[0]}</th>`).join('') + '</tr></thead><tbody>'
      + (rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="mst-empty">No messages in the window</td></tr>`) + '</tbody>';
  }
  const bar = (frac, cls = '') => `<span class="mst-bar-cell"><span class="mst-fill ${cls}" style="width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%"></span></span>`;

  function renderDf(d) {
    const tot = d.totals.msgs - d.totals.err - d.totals.dec_err - d.totals.blocked;
    const rows = d.df.map(r => `<tr><td class="mst-code">DF${r.df}</td><td>${esc(DF_NAME[r.df] || '')}</td>`
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

  function renderIid(d) {
    const io = d.iid;
    const sq = io.rows.find(r => r.type === 'SQ');
    const rows = io.rows.filter(r => r.type !== 'SQ').map(r => `<tr><td class="mst-code">${r.type} ${r.code}</td>`
      + `<td class="num">${fmtRate(r.rate)}</td><td class="num">${r.n.toLocaleString('en')}</td><td class="num">${r.ac ?? '—'}</td>`
      + `<td class="num">${hhmm(r.first)}</td><td class="num">${ago(d.now - r.last)}</td></tr>`);
    if (sq) rows.push(`<tr class="mst-dim"><td>Acquisition squitter</td><td class="num">${fmtRate(sq.rate)}</td><td class="num">${sq.n.toLocaleString('en')}</td><td colspan="3">spontaneous, no interrogator</td></tr>`);
    table('mst-iid', [['Code', 'II = interrogator identifier (1–15), SI = surveillance identifier (1–63)'], ['/s', 'Replies per second', 'num'],
      ['Replies', 'In the window', 'num'], ['Aircraft', 'Distinct aircraft that replied to it', 'num'],
      ['First', 'First heard since the server started (UTC)', 'num'], ['Last', 'Time since the last reply', 'num']], rows);
    const quiet = io.quiet.map(q => `${q.type} ${q.code} (last ${hhmm(q.last)})`).join(', ');
    const um = io.um.slice(0, 6).map(u => `IIS ${u.iis}/IDS ${u.ids}: ${u.n}`).join(' · ');
    $('mst-iid-foot').innerHTML = 'An all-call reply (DF11) carries the code of the ground interrogator that asked; '
      + 'which code belongs to which radar or WAM site is not published, but a code that disappears or a new one shows a change. '
      + `Corrupted DF11: ${io.df11_bad}.`
      + (quiet ? `<br><b>Heard earlier, not in this window:</b> ${esc(quiet)}` : '')
      + (um ? `<br><span title="Utility message of the surveillance and Comm-B replies: IIS = the interrogator holding a reservation, IDS = its type (1 Comm-B, 2 Comm-C, 3 Comm-D)">Reservations (UM): ${esc(um)}</span>` : '');
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

  // ── chart ─────────────────────────────────────────────────────────────────
  function chartData(d) {
    const keys = d.trend.keys, rows = d.trend.rows;
    const col = k => keys.indexOf(k);
    const sel = range === '1h' ? rows.slice(-60) : rows;
    const lbl = r => hhmm(r[0]);
    const per = k => sel.map(r => r[col(k)] == null ? null : +(r[col(k)] / 60).toFixed(2));
    const raw = k => sel.map(r => r[col(k)]);
    const C = [css('--accent'), css('--green'), css('--amber'), css('--purple') || '#8b5cf6', css('--red')];
    if (series === 'rate' && range === '1h') {
      const ten = d.ten.slice(-360);
      return { labels: ten.map(t => hhmm(t[0])), sets: [['Messages/s', ten.map(t => t[1] / 10), C[0]]], unit: '/s' };
    }
    const L = sel.map(lbl);
    switch (series) {
      case 'formats': return { labels: L, unit: '/s', sets: [
        ['DF4/5', sel.map((r, i) => +((r[col('df4')] + r[col('df5')]) / 60).toFixed(2)), C[0]], ['DF11', per('df11'), C[3]],
        ['DF17', per('df17'), C[1]], ['DF20/21', sel.map(r => +((r[col('df20')] + r[col('df21')]) / 60).toFixed(2)), C[2]]] };
      case 'regs': return { labels: L, unit: '/s', sets: [['BDS 5,0', per('bds50'), C[0]], ['BDS 6,0', per('bds60'), C[1]],
        ['BDS 4,0', per('bds40'), C[2]], ['BDS 2,0', per('bds20'), C[3]]] };
      case 'aircraft': return { labels: L, unit: '', sets: [['Aircraft', raw('ac'), C[0]], ['EHS aircraft', raw('ehs'), C[1]]] };
      case 'cad': return { labels: L, unit: 's', sets: [['Final', raw('cad50_final'), C[4]], ['Terminal', raw('cad50_term'), C[2]],
        ['En route', raw('cad50_enr'), C[0]]] };
      case 'iid': return { labels: L, unit: '', sets: [['Interrogator codes heard', raw('iid_n'), C[3]]] };
      default: return { labels: L, unit: '/s', sets: [['Messages/s', per('msgs'), C[0]]] };
    }
  }

  function renderChart(d) {
    if (typeof Chart === 'undefined') return;
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
    if (chart) { chart.data = cfg.data; chart.options = cfg.options; chart.update('none'); }
    else chart = new Chart($('mst-chart'), cfg);
  }

  // ── polling ───────────────────────────────────────────────────────────────
  function renderAll() {
    if (!data) return;
    const parts = [renderBar, renderDf, renderBds, renderTc, renderCad, renderIid, renderMeteo, renderChart];
    for (const f of parts) { try { f(data); } catch (e) { console.error('stats', f.name, e); } }
  }
  async function poll() {
    clearTimeout(timer);
    if (document.hidden) return;
    try {
      const r = await fetch('/api/msgstats?window=' + win);
      data = await r.json();
      renderAll();
    } catch (e) {
      $('mst-updated').textContent = 'Update failed — retrying';
    }
    timer = setTimeout(poll, POLL_MS);
  }

  function initButtons() {
    document.querySelectorAll('#mst-win-btns .gps-zone-btn').forEach(b => {
      b.classList.toggle('active', +b.dataset.win === win);
      b.addEventListener('click', () => {
        win = +b.dataset.win;
        try { localStorage.setItem('ms_statsWindow', String(win)); } catch (e) { /* */ }
        document.querySelectorAll('#mst-win-btns .gps-zone-btn').forEach(x => x.classList.toggle('active', x === b));
        poll();
      });
    });
    document.querySelectorAll('#mst-chart-range .gps-range-btn').forEach(b => b.addEventListener('click', () => {
      range = b.dataset.range;
      document.querySelectorAll('#mst-chart-range .gps-range-btn').forEach(x => x.classList.toggle('active', x === b));
      if (data) renderChart(data);
    }));
    const s = $('mst-chart-series');
    s.value = series;
    s.addEventListener('change', () => { series = s.value; try { localStorage.setItem('ms_statsSeries', series); } catch (e) { /* */ } if (data) renderChart(data); });
    const k = $('mst-cad-kind');
    k.value = cadKind;
    k.addEventListener('change', () => { cadKind = k.value; try { localStorage.setItem('ms_statsCad', cadKind); } catch (e) { /* */ } if (data) renderCad(data); });
  }

  window.onThemeChange = () => { if (chart) { chart.destroy(); chart = null; } if (data) renderChart(data); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  initButtons();
  poll();
})();
