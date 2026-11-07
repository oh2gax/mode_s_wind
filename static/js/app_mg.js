/**
 * app_mg.js — the phone's Meteogram view (/app, from 2026-11-05).
 *
 * The meteogram of one place — the airport by default, or a place tapped on the
 * Weather view's map ("Meteogram here" in its tap card) — from
 * /api/weather/meteogram, drawn by the shared meteogram.js in its compact layout
 * (the same drawing as the Weather page's Meteogram view): temperature,
 * precipitation, wind with barbs, pressure and clouds on one time axis (UTC).
 *
 *   Place  EFHK · the receiver sites (RX-01 …, from the evening of 5 Nov 2026: the maps'
 *          receiver triangles, to 0.01°) · the tapped place (kept until another is tapped)
 *   Model  MEPS (the past 6 h and its ~2.5 days ahead) · GFS · Both (GFS thin and
 *          dashed, MEPS bold over its own hours); GFS only where the server has it
 *   Range  2 d · 5 d · 7 d · 10 d · 16 d (GFS and Both; MEPS has its own forecast only)
 *   Panels the Meteogram options of the ☰ menu (Pressure off by default)
 *   850 hPa (from 2026-11-07; ☰ menu, off by default) the 850 hPa temperature in the temperature
 *          panel: the models' line and MODE-S Wind's own measured value of the past hours as dots
 *   (from 2026-11-07 afternoon; ☰ menu, off by default) Freezing level and CAPE panels; METAR,
 *          Landings' winds, Sun times, Dew point & visibility, 850 hPa wind (meteogram.js)
 *   Typical error (with GFS, from 2026-11-06; ☰ menu, on by default) a band around the temperature
 *          and wind lines — how far off the forecast has been at that lead day, 8 in 10 checked hours
 *          within it (/api/weather/gfs_skill) — and a line under the chart
 * FIN (from 2026-11-07): for a user with the FIN right (window.MG_LANG 'fi', app.html) the texts
 * of this view and the chart are in Finnish (decimal commas; times UTC).
 * A tap or a drag on the chart gives the values of that hour above it.  The
 * choices are remembered on the phone (ms_app_mg_*).  app.js calls show / hide /
 * refresh (every 10 min while shown) / layout; openAt(lat, lon) is called by the
 * Weather view's tap card.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) { /* private mode */ } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (!$('v-mg') || typeof Meteogram === 'undefined') return;
  // the language (from 2026-11-07): Finnish for the users with the FIN right
  const FI = window.MG_LANG === 'fi';
  const tr = (en, fi) => (FI ? fi : en);
  const dc = s => (FI ? String(s).replace(/\./g, ',') : String(s));

  const APT = typeof MG_AIRPORT !== 'undefined' ? MG_AIRPORT : { icao: 'EFHK', lat: 60.317, lon: 24.963 };
  const GFS = typeof MG_GFS !== 'undefined' && !!MG_GFS;
  const PANELS = ['temp', 'frz', 'precip', 'cape', 'wind', 'pres', 'cloud'];   // frz, cape from 2026-11-07 (off by default)
  const OPTS = ['obs', 'lw', 'sun', 'dew', 'w850'];                            // from 2026-11-07, off by default
  const RANGES = ['48', '120', '168', '240', '384'];          // 7 d and 10 d from 2026-11-06
  const S = {
    model: lsGet('ms_app_mg_model', GFS ? 'both' : 'meps'),
    range: lsGet('ms_app_mg_range', '120'),
    place: lsGet('ms_app_mg_place', 'apt'),
    pin: (() => { try { const p = JSON.parse(lsGet('ms_app_mg_pin', 'null')); return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null; } catch (_) { return null; } })(),
    panels: {},
    err: lsGet('ms_app_mg_err', 'true') !== 'false',
    t850: lsGet('ms_app_mg_t850', 'false') === 'true',     // the 850 hPa temperature (from 2026-11-07; off by default)
  };
  PANELS.forEach(k => { S.panels[k] = lsGet('ms_app_mg_' + k, ['pres', 'frz', 'cape'].includes(k) ? 'false' : 'true') !== 'false'; });
  OPTS.forEach(k => { S[k] = lsGet('ms_app_mg_' + k, 'false') === 'true'; });
  if (!GFS || !['meps', 'gfs', 'both'].includes(S.model)) S.model = GFS && ['gfs', 'both'].includes(S.model) ? S.model : 'meps';
  if (!RANGES.includes(S.range)) S.range = '120';
  if (!(S.place === 'pin' && S.pin) && !S.place.startsWith('rx:')) S.place = 'apt';
  let rxs = [];                                   // Meteogram.receivers()

  let on = false, seq = 0, chart = null, data = null, fetched = 0, skill = null;
  const fmtLL = (lat, lon) => `${dc(Math.abs(lat).toFixed(2))}° ${lat >= 0 ? 'N' : 'S'} ${dc(Math.abs(lon).toFixed(2))}° ${lon >= 0 ? 'E' : 'W'}`;
  const runTxt = r => { const d = new Date(r * 1000); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${String(d.getUTCHours()).padStart(2, '0')} UTC`; };
  const place = () => {
    const r = S.place.startsWith('rx:') && rxs.find(x => 'rx:' + x.id === S.place);
    if (r) return { lat: r.lat, lon: r.lon, title: r.label, sub: r.short };
    if (S.place === 'pin' && S.pin) return { lat: S.pin.lat, lon: S.pin.lon, title: tr('Tapped place', 'Napautettu paikka'), sub: fmtLL(S.pin.lat, S.pin.lon) };
    return { lat: APT.lat, lon: APT.lon, title: APT.icao, sub: APT.icao, apt: true };
  };
  const curPlace = () => { const r = S.place.startsWith('rx:') && rxs.find(x => 'rx:' + x.id === S.place); return r || S.place === 'pin' ? S.place : 'apt'; };

  // ── the chips at the top of the view ────────────────────────────────────
  function chips(id, items, cur, onPick) {
    const box = $(id);
    box.innerHTML = items.map(([v, t, dis]) =>
      `<button type="button" class="app-chip${v === cur ? ' on' : ''}" data-v="${esc(v)}" aria-pressed="${v === cur}"${dis ? ' disabled' : ''}>${esc(t)}</button>`).join('');
    box.onclick = e => { const b = e.target.closest('.app-chip'); if (b && !b.disabled && b.dataset.v !== cur) onPick(b.dataset.v); };
  }
  function syncChips() {
    chips('amg-place', [['apt', APT.icao]].concat(rxs.map(r => ['rx:' + r.id, r.short]), S.pin ? [['pin', tr('Tapped', 'Napautettu')]] : []), curPlace(), v => {
      S.place = v; lsSet('ms_app_mg_place', v); syncChips(); load(true);
    });
    const models = [['meps', 'MEPS']].concat(GFS ? [['gfs', 'GFS'], ['both', tr('Both', 'Molemmat')]] : []);
    chips('amg-model', models, S.model, v => { S.model = v; lsSet('ms_app_mg_model', v); syncChips(); load(true); });
    $('amg-model-row').hidden = !GFS;
    const meps = S.model === 'meps';
    chips('amg-range', [['48', '2'], ['120', '5'], ['168', '7'], ['240', '10'], ['384', '16']].map(r => [r[0], r[1] + tr(' d', ' vrk'), meps && r[0] !== '48']),
      meps ? '48' : S.range, v => { S.range = v; lsSet('ms_app_mg_range', v); syncChips(); load(true); });
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function load(force) {
    if (!on) return;
    if (!force && data && Date.now() - fetched < 9 * 60e3) { draw(); return; }
    const my = ++seq;
    const p = place(), m = S.model, rng = m === 'meps' ? 80 : parseInt(S.range, 10);
    const q = `lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`;
    const want = m === 'both' ? ['meps', 'gfs'] : [m];
    const url = k => k === 'meps' ? `/api/weather/meteogram?${q}&model=meps&past=6&fc=${rng}`
      : `/api/weather/meteogram?${q}&model=gfs&past=2&fc=${rng}`;
    $('amg-head').innerHTML = `<b>${esc(p.title)}</b> · ${fmtLL(p.lat, p.lon)} · ${tr('loading…', 'ladataan…')}`;
    if (GFS && Meteogram.skill) Meteogram.skill().then(sk => { if (sk !== skill) { skill = sk; if (on && data) draw(); } });
    try {
      const res = await Promise.all(want.map(k => fetch(url(k)).then(r => r.json()).catch(() => ({ error: 'loading failed' }))));
      if (my !== seq || !on) return;
      const d = {};
      want.forEach((k, i) => { d[k] = res[i] && !res[i].error ? res[i] : null; d[k + 'Err'] = res[i] && res[i].error; });
      data = d; fetched = Date.now();
      draw();
    } catch (e) {
      console.error('Meteogram:', e);
      $('amg-head').innerHTML += tr(' · error loading', ' · lataus epäonnistui');
    }
  }
  function draw() {
    if (!data) return;
    const p = place();
    const cells = [];
    if (data.meps) cells.push(`MEPS${tr('', ':n')} ${dc(data.meps.cell.fine_grid ? '2.5 km' : '10 km')} ${tr('cell', '-ruutu')}`);
    if (data.gfs) cells.push(tr('GFS 0.25° cell', 'GFS:n 0,25° -ruutu'));
    $('amg-head').innerHTML = `<b>${esc(p.title)}</b> · ${fmtLL(p.lat, p.lon)}` + (cells.length ? ' · ' + cells.join(' · ') : '');
    if (chart) chart.destroy();
    const err = [data.mepsErr, data.gfsErr].filter(Boolean);
    const eb = GFS && S.err && Meteogram.errBand ? Meteogram.errBand(skill, p.apt ? '' : tr('measured at ', 'mitattu kentällä ') + APT.icao) : null;
    chart = Meteogram.render($('amg-chart'), { meps: data.meps, gfs: data.gfs }, {
      compact: true, panels: Object.assign({}, S.panels), errBand: eb, t850: S.t850,
      obs: S.obs, lw: S.lw, sun: S.sun, dew: S.dew, w850: S.w850,
      lang: FI ? 'fi' : 'en',
      emptyText: err.length ? err.join(' · ') : tr('No model hours for this place.', 'Tälle paikalle ei ole mallin tunteja.') });
    const runs = [];
    if (data.meps) runs.push(`${tr('MEPS run', 'MEPS-ajo')} ${runTxt(Math.max(...data.meps.runs))} — MET Norway, CC BY 4.0`);
    if (data.gfs) runs.push(`${tr('GFS run', 'GFS-ajo')} ${runTxt(Math.max(...data.gfs.runs))}${tr(', hourly to +120 h then every 3 h — NOAA/NCEP; beyond a week a rough guide only', ', tunneittain +120 h asti, sitten 3 h välein — NOAA/NCEP; yli viikon päähän vain suuntaa antava')}`);
    if (err.length && (data.meps || data.gfs)) runs.push(err.join(' · '));
    const sk = GFS && S.err ? skillLine() : '';
    $('amg-foot').textContent = (sk ? sk + ' · ' : '') + runs.join(' · ') + tr(' · times UTC · the model at the grid cell of the place, for viewing — for flight operations use the official forecasts (TAF, GAFOR).',
      ' · ajat UTC · malli paikan hilaruudussa, vain katseluun — lentotoimintaan käytä virallisia ennusteita (TAF, GAFOR).');
    const sub = $('app-sub');
    if (sub && on) sub.textContent = p.sub;
  }

  // one line on how good GFS has been at the airport (8 in 10 hours within ± …, useful to about day N)
  function skillLine() {
    if (!skill || skill.error || !skill.gfs) return '';
    const parts = [];
    [1, 3, 5, 10].forEach(d => {
      const r = skill.gfs.find(x => x.day === d);
      if (r && r.ok && r.t && r.t.p80 != null) parts.push(tr(`±${r.t.p80.toFixed(1)} °C on day ${d}`, `±${dc(r.t.p80.toFixed(1))} °C päivänä ${d}`));
    });
    if (!parts.length) return tr(`GFS at ${skill.station}: the typical error is still being collected`, `GFS kentällä ${skill.station}: tyypillistä virhettä kerätään vielä`);
    const ud = skill.useful_day, u = skill.gfs_useful || {};
    const known = Math.min((u.t || {}).known || 0, (u.wv || {}).known || 0);
    const use = ud ? (ud >= known && known < 16 ? tr(` · better than the season's usual weather at least to day ${ud} so far`, ` · toistaiseksi vuodenajan tavallista säätä parempi ainakin päivään ${ud} asti`)
      : tr(` · useful to about day ${ud}`, ` · hyödyllinen noin päivään ${ud} asti`)) : '';
    return tr(`GFS at ${skill.station}, last ${Math.round(skill.window_days)} days: temperature ${parts.join(', ')} (8 in 10 hours within)${use}`,
              `GFS kentällä ${skill.station}, viimeiset ${Math.round(skill.window_days)} vrk: lämpötila ${parts.join(', ')} (8 tuntia 10:stä sisällä)${use}`);
  }

  // ── the options of the ☰ menu ───────────────────────────────────────────
  PANELS.forEach(k => {
    const cb = $('app-mg-' + k);
    if (!cb) return;
    cb.checked = S.panels[k];
    cb.addEventListener('change', () => { S.panels[k] = cb.checked; lsSet('ms_app_mg_' + k, cb.checked); if (on) draw(); });
  });
  const ecb = $('app-mg-err');
  if (ecb) {
    ecb.checked = S.err;
    ecb.addEventListener('change', () => { S.err = ecb.checked; lsSet('ms_app_mg_err', ecb.checked); if (on) draw(); });
  }
  OPTS.forEach(k => {
    const cb = $('app-mg-' + k);
    if (!cb) return;
    cb.checked = S[k];
    cb.addEventListener('change', () => { S[k] = cb.checked; lsSet('ms_app_mg_' + k, cb.checked); if (on) draw(); });
  });
  const tcb = $('app-mg-t850');
  if (tcb) {
    tcb.checked = S.t850;
    tcb.addEventListener('change', () => { S.t850 = tcb.checked; lsSet('ms_app_mg_t850', tcb.checked); if (on) draw(); });
  }
  syncChips();
  // the receiver sites (the place chosen before comes back once they are known)
  Meteogram.receivers().then(list => {
    rxs = list;
    syncChips();
    if (on && S.place.startsWith('rx:')) load(true);
  });

  window.AppMg = {
    show() { on = true; syncChips(); load(false); },
    hide() { on = false; if (chart) { chart.destroy(); chart = null; } },
    refresh() { load(true); },
    layout() { if (on && chart && chart.redraw) chart.redraw(); },
    // the Weather view's tap card: the meteogram of that place
    openAt(lat, lon) {
      S.pin = { lat: +lat, lon: +lon }; S.place = 'pin';
      lsSet('ms_app_mg_pin', JSON.stringify(S.pin)); lsSet('ms_app_mg_place', 'pin');
      data = null;
      if (typeof window.AppSetView === 'function') window.AppSetView('mg');
      else { syncChips(); load(true); }
    },
  };
})();
