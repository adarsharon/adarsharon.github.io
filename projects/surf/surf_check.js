/*
 * Surf Check: adarsharon.com/surf
 * Beginner go/no-go verdicts for LA westside beaches.
 *
 * Runs in the browser. Data sources, tried in order until one works:
 *   1. Surfline "KBYG" endpoints: off (TRY_SURFLINE = false), as on PythonAnywhere,
 *      where the free-tier proxy blocked them.
 *   2. Open-Meteo Marine + Forecast APIs. Requests now come from your own
 *      browser, so the daily quota is yours alone (on PythonAnywhere it was
 *      shared by every free account).
 *   3. NWS gridpoints (api.weather.gov), with no daily quota.
 * Tides always come from NOAA CO-OPS; rain always from Open-Meteo (if that
 * fails, the page shows a "couldn't verify rainfall" warning).
 * Responses are cached in the browser (localStorage) for 30 minutes.
 *
 * The verdict logic is calibrated for an EXTREME BEGINNER who mostly rides
 * whitewash and is starting to try small green waves. Surfline's own ratings
 * are calibrated for experienced surfers, so we deliberately ignore the
 * POOR/FAIR/GOOD label and score the raw numbers instead.
 *
 * Beaches are configured in beaches.json next to this file.
 * Browser version of the PythonAnywhere blueprint surf_checker.py (moved here
 * Nov 2026); the verdict logic below follows the Python code line by line.
 */
"use strict";

const BEACHES_FILE = "/projects/surf/beaches.json";
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const TRY_SURFLINE = false;

// You've moved past whitewash: only green (unbroken) waves count now. In this
// mode the headline verdict tracks green-wave quality and the whitewash
// sub-verdict is hidden. Flip to false to bring whitewash back.
const GREEN_ONLY = true;

const FORECAST_DAYS = 5;  // how far ahead the date picker goes
const TZ = "America/Los_Angeles";

// ----------------------------------------------------------------------
// Thresholds (feet, mph, mm). Tune these as your skill improves.
// ----------------------------------------------------------------------
const TH = {
  flat_below_ft: 1.0,        // below this: probably too weak even for whitewash
  go_max_ft: 3.5,            // sweet spot ceiling for beginner green waves
  maybe_max_ft: 5.0,         // above go_max: whitewash-only territory
  wind_calm_mph: 12.0,       // below this (or offshore): clean
  wind_maybe_mph: 18.0,      // above this: blown out for a beginner
  rain_72h_mm: 2.5,          // ~0.1 in; LA's 72-hour water-quality rule
  long_period_s: 16.0,       // long-period groundswell packs extra punch
  long_period_min_ft: 3.0,   // ...but only worrying if there's real size
  short_period_s: 9.0,       // short-period windswell = disorganized mush
  short_period_wind_mph: 10.0,  // ...that gets genuinely bad with any wind on it
  tide_high_ft: 5.0,         // high tide: whitewash zone deepens, shore-dump
  tide_low_ft: 0.0,          // negative tide: drained, closeouts
  penalties_nogo: 2,         // this many independent "meh" factors = don't go
  // --- Closeout risk (fast top-to-bottom breaking, no rideable face) ---
  // On a featureless sandy beachbreak, a longer-period swell that jacks up
  // fast + a low tide that drains the bar + small size (no shoulder) makes
  // waves break all at once. Fine to bail through on whitewash, but there's
  // no green-wave face to ride. Each is a tunable contributor below.
  closeout_period_min_s: 12.0,   // swell period at/above this jacks up steeply (aggravator)
  closeout_size_max_ft: 3.5,     // small enough that there's no shoulder (aggravator)
  closeout_tide_low_ft: 1.0,     // at/below this: low-tide shorebreak closeouts on their
                                 // own (calibrated to Jul 19 SM South: 0-0.7 ft, closing out)
  closeout_tide_max_ft: 2.0,     // 1.0-2.0 ft: risky if any aggravator present, else caution
};

// ----------------------------------------------------------------------
// Python-compatible number handling
// ----------------------------------------------------------------------

// round(x, nd) as in Python: correctly rounded, exact ties go to the even digit.
function pyRound(x, nd = 0) {
  if (x === null || x === undefined || typeof x !== "number" || Number.isNaN(x)) {
    throw new TypeError("type " + (x === null ? "NoneType" : typeof x) + " doesn't define __round__ method");
  }
  const exact = Math.abs(x).toFixed(100);
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + nd);
  if (/^50*$/.test(tail)) {  // exact tie
    const kept = exact.slice(0, dot + 1 + nd).replace(".", "");
    const lastDigit = +kept[kept.length - 1];
    const down = Number(exact.slice(0, dot + (nd ? 1 + nd : 0)));
    const r = lastDigit % 2 === 0 ? down : down + Math.pow(10, -nd);
    return Math.sign(x) * Number(r.toFixed(nd));
  }
  return Number(x.toFixed(nd));
}
// str() of a Python float: 2.0 -> "2.0"; ints stay "2" when isInt is set.
function pyStr(x, isInt = false) {
  if (x === null || x === undefined) return "None";
  if (Object.is(x, -0)) return isInt ? "0" : "-0.0";
  if (Number.isInteger(x) && !isInt) return x.toFixed(1);
  return String(x);
}

// ----------------------------------------------------------------------
// Time helpers. "Naive" times are LA wall-clock times stored as if they were
// UTC milliseconds, mirroring the naive datetimes of the Python version.
// ----------------------------------------------------------------------
const fmtCache = {};
function wallParts(tz, ms) {
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
function tzOffsetMs(tz, ms) {
  const w = wallParts(tz, ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}
function naiveToUtc(naive, tz) {  // zoneinfo fold=0 semantics
  const before = tzOffsetMs(tz, naive - 86400000), after = tzOffsetMs(tz, naive + 86400000);
  const valid = (o) => tzOffsetMs(tz, naive - o) === o;
  let off = before;
  if (before !== after && !valid(before) && valid(after)) off = after;
  return naive - off;
}
function nowLa() {
  const w = wallParts(TZ, Date.now());
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}
function parseNaive(s) {  // "2026-11-12T09:00" or "2026-11-12 09:00"
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error("Invalid isoformat string: '" + s + "'");
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}
const pad2 = (n) => String(n).padStart(2, "0");
const HOUR = 3600000;

// ----------------------------------------------------------------------
// Config + cache helpers
// ----------------------------------------------------------------------
async function loadBeaches() {
  const resp = await fetch(BEACHES_FILE + "?t=" + Date.now());
  return (await resp.json()).beaches;
}

const CACHE_PREFIX = "surf-cache:";
const inflight = new Map();
let fetchImpl = (url, opts) => fetch(url, opts);  // replaced in tests

function cacheRead(url) {
  try {
    const e = JSON.parse(localStorage.getItem(CACHE_PREFIX + url));
    if (e && Date.now() - e.t < CACHE_TTL_MS) return e;
  } catch (_) { /* no cache */ }
  return null;
}
function cacheWrite(url, data) {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) {
        try { if (now - JSON.parse(localStorage.getItem(k)).t >= CACHE_TTL_MS) localStorage.removeItem(k); }
        catch (_) { localStorage.removeItem(k); }
      }
    }
    localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ t: now, data }));
  } catch (_) { /* cache is best-effort only */ }
}

// GET a URL and return parsed JSON, with a 30-min browser cache.
async function cachedGetJson(url) {
  const hit = typeof localStorage !== "undefined" ? cacheRead(url) : null;
  if (hit) return hit.data;
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let resp;
    try { resp = await fetchImpl(url, { signal: ctrl.signal }); }
    catch (e) { throw e.name === "AbortError" ? new Error(url.split("/")[2] + " timed out") : e; }
    finally { clearTimeout(timer); }
    if (resp.status !== 200) {
      const text = await resp.text();
      throw new Error(url.split("/")[2] + " returned " + resp.status + ": " + text.slice(0, 120));
    }
    const data = await resp.json();
    if (typeof localStorage !== "undefined") cacheWrite(url, data);
    return data;
  })();
  inflight.set(url, p);
  try { return await p; } finally { inflight.delete(url); }
}

// ----------------------------------------------------------------------
// Unit helpers
// ----------------------------------------------------------------------
const mToFt = (m) => m * 3.28084;
const ktsToMph = (k) => k * 1.15078;
const KMH_TO_MPH = 0.621371;
function compass(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.trunc(deg / 22.5 + 0.5) % 16];
}
function angDiff(a, b) {  // smallest absolute angle between two bearings
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}
function argminBy(list, f) {  // first element with the smallest f (like Python's min)
  let best = null, bestV = Infinity;
  for (const x of list) { const v = f(x); if (best === null || v < bestV) { best = x; bestV = v; } }
  if (best === null) throw new Error("min() arg is an empty sequence");
  return best;
}

// ----------------------------------------------------------------------
// Data source 1: Surfline KBYG
// ----------------------------------------------------------------------
const KBYG = "https://services.surfline.com/kbyg/spots/forecasts";

async function fetchSurfline(spotId, target) {
  const wave = await cachedGetJson(`${KBYG}/wave?spotId=${spotId}&days=${FORECAST_DAYS}&intervalHours=1`);
  const wind = await cachedGetJson(`${KBYG}/wind?spotId=${spotId}&days=${FORECAST_DAYS}&intervalHours=1`);
  const tides = await cachedGetJson(`${KBYG}/tides?spotId=${spotId}&days=${FORECAST_DAYS}`);
  const assoc = wave.associated || {};
  const utcOffset = assoc.utcOffset ?? -7;
  const heightUnit = ((assoc.units || {}).waveHeight || "FT").toUpperCase();
  const localDt = (ts) => ts * 1000 + utcOffset * HOUR;
  const nearest = (entries) => argminBy(entries, (e) => Math.abs(localDt(e.timestamp) - target));

  const w = nearest(wave.data.wave);
  if (Math.abs(localDt(w.timestamp) - target) > 6 * HOUR) throw new Error("Surfline forecast does not cover the requested time");
  let surfMin = w.surf.min, surfMax = w.surf.max;
  if (heightUnit === "M") { surfMin = mToFt(surfMin); surfMax = mToFt(surfMax); }
  let period = null;
  const swells = (w.swells || []).filter((s) => s.height);
  if (swells.length) period = argminBy(swells, (s) => -s.height).period;

  const wd = nearest(wind.data.wind);
  const windUnit = (((wind.associated || {}).units || {}).windSpeed || "KTS").toUpperCase();
  let speed = wd.speed;
  if (windUnit === "KTS") speed = ktsToMph(speed);
  else if (windUnit === "KPH") speed = speed * KMH_TO_MPH;

  let tideFt = null;
  const tideEntries = (tides.data || {}).tides || [];
  if (tideEntries.length) {
    const t = nearest(tideEntries);
    tideFt = t.height ?? null;
    const tideUnit = (((tides.associated || {}).units || {}).tideHeight || "FT").toUpperCase();
    if (tideUnit === "M" && tideFt !== null) tideFt = mToFt(tideFt);
  }
  return {
    source: "Surfline",
    surf_min_ft: pyRound(surfMin, 1),
    surf_max_ft: pyRound(surfMax, 1),
    period_s: period ? pyRound(period, 1) : null,
    wind_mph: pyRound(speed, 1),
    wind_dir: wd.direction ?? null,
    tide_ft: tideFt !== null ? pyRound(tideFt, 1) : null,
  };
}

// ----------------------------------------------------------------------
// Data source 2: Open-Meteo (fallback for waves/wind; always for rain)
// ----------------------------------------------------------------------

// Tide height (ft, MLLW) at target from NOAA CO-OPS predictions.
// Station 9410840 is on the Santa Monica Pier itself. Returns null on failure.
async function fetchNoaaTide(station, target) {
  try {
    const d = new Date(target);
    const day = d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
    const data = await cachedGetJson(
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter" +
      `?product=predictions&station=${station}&datum=MLLW` +
      "&units=english&time_zone=lst_ldt&interval=h&format=json" +
      `&begin_date=${day}&end_date=${day}`);
    const preds = data.predictions || [];
    if (!preds.length) return null;
    const best = argminBy(preds, (p) => Math.abs(parseNaive(p.t) - target));
    const v = parseFloat(best.v);
    if (Number.isNaN(v)) return null;
    return pyRound(v, 1);
  } catch (_) {
    return null;
  }
}

// Komar-Gaughan (1972) breaking-height estimate from deep-water height and
// period: Hb = 0.39 g^0.2 (T H0^2)^0.4. Long-period swell shoals up hard:
// 0.6 m of 15 s groundswell breaks at ~1.2 m, which is exactly the
// 'looked small on the forecast, surprised me at the beach' failure mode.
function breakingHeightFt(hM, tS) {
  if (!hM || !tS || hM <= 0 || tS <= 0) return 0.0;
  const hbM = 0.39 * Math.pow(9.81, 0.2) * Math.pow(tS * hM ** 2, 0.4);
  return mToFt(hbM);
}

async function fetchOpenmeteo(lat, lon, target, noaaStation = null, exposure = 1.0, tz = TZ) {
  const tzQ = tz.replace(/\//g, "%2F");
  const marine = await cachedGetJson(
    "https://marine-api.open-meteo.com/v1/marine" +
    `?latitude=${lat}&longitude=${lon}` +
    "&hourly=wave_height,wave_period,swell_wave_height,swell_wave_period," +
    "swell_wave_direction,wind_wave_height,wind_wave_period" +
    `&forecast_days=7&timezone=${tzQ}`);
  const forecast = await cachedGetJson(
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&hourly=wind_speed_10m,wind_direction_10m" +
    `&wind_speed_unit=mph&forecast_days=7&timezone=${tzQ}`);

  function pick(block, key) {
    const times = block.hourly.time, vals = block.hourly[key];
    if (vals === undefined) throw new Error("'" + key + "'");
    const idx = times.map((_, i) => i);
    const bestI = argminBy(idx, (i) => Math.abs(parseNaive(times[i]) - target));
    if (Math.abs(parseNaive(times[bestI]) - target) > 6 * HOUR) throw new Error("Open-Meteo forecast does not cover the requested time");
    return vals[bestI];
  }
  function pickOrNone(block, key) {  // missing data -> null; a coverage gap still raises
    if (!block || !block.hourly || !Array.isArray(block.hourly.time) || !Array.isArray(block.hourly[key])) return null;
    return pick(block, key);
  }

  // Breaking-height estimate per swell component, then combine (RMS).
  const hsSw = pickOrNone(marine, "swell_wave_height"), tSw = pickOrNone(marine, "swell_wave_period");
  const hsWw = pickOrNone(marine, "wind_wave_height"), tWw = pickOrNone(marine, "wind_wave_period");
  const swellDir = pickOrNone(marine, "swell_wave_direction");
  const hbSw = breakingHeightFt(hsSw, tSw);
  const hbWw = breakingHeightFt(hsWw, tWw);
  let hb, period;
  if (hbSw || hbWw) {
    hb = Math.sqrt(hbSw ** 2 + hbWw ** 2);
    period = hbSw >= hbWw ? tSw : tWw;
  } else {  // decomposition missing: fall back to totals
    hb = breakingHeightFt(pick(marine, "wave_height"), pick(marine, "wave_period"));
    period = pick(marine, "wave_period");
  }

  // Spot exposure: Santa Monica Bay is partly shadowed (Channel Islands,
  // Palos Verdes), so open-water swell arrives reduced. Tunable per beach
  // in beaches.json by comparing against Surfline's website for a few days.
  hb *= exposure;

  // For the closeout check we want the SWELL (groundswell) period even when a
  // small windsea dominates the height: a long-period groundswell under a
  // tiny windsea is exactly the sneaky closeout maker. Report that as the
  // period whenever a real groundswell (>= long_period-ish) is present.
  let reportPeriod = period;
  if (tSw && tSw >= TH.closeout_period_min_s && (hsSw || 0) >= 0.3) reportPeriod = tSw;

  const cond = {
    source: noaaStation ? "Open-Meteo + NOAA tides" : "Open-Meteo",
    surf_min_ft: pyRound(hb * 0.8, 1),
    surf_max_ft: pyRound(hb, 1),
    period_s: reportPeriod ? pyRound(reportPeriod, 1) : null,
    wind_mph: pyRound(pick(forecast, "wind_speed_10m"), 1),
    wind_dir: pick(forecast, "wind_direction_10m"),
    swell_dir: swellDir !== null ? pyRound(swellDir) : null,
    tide_ft: null,
  };
  cond.tide_ft = noaaStation ? await fetchNoaaTide(noaaStation, target) : null;
  return cond;
}

// 'PT6H' / 'P1D' / 'P1DT12H' -> milliseconds. NWS uses these in validTime.
function parseIsoDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s);
  if (!m) return HOUR;
  const [d, h, mi] = [m[1], m[2], m[3]].map((x) => (x ? +x : 0));
  return ((d * 24 + h) * 60 + mi) * 60000;
}

// Value from an NWS gridpoint property whose interval contains targetUtc.
function nwsValue(prop, targetUtc) {
  let best = null, bestGap = null;
  for (const entry of prop.values || []) {
    const [startS, durS] = entry.validTime.split("/");
    const start = Date.parse(startS);
    const end = start + parseIsoDuration(durS);
    if (start <= targetUtc && targetUtc < end) return entry.value;
    const gap = Math.abs(start - targetUtc);
    if (bestGap === null || gap < bestGap) { best = entry.value; bestGap = gap; }
  }
  if (bestGap !== null && bestGap <= 6 * HOUR) return best;
  throw new Error("NWS forecast does not cover the requested time");
}

// Waves + wind from the National Weather Service gridpoint API. Wave data
// lives on marine grid cells, so we query a point nudged ~2.5 km offshore.
async function fetchNws(lat, lon, target, exposure = 1.0, tz = TZ) {
  const t = new Date(target);
  const targetUtc = naiveToUtc(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()), tz);
  const points = await cachedGetJson(`https://api.weather.gov/points/${lat},${lon - 0.025}`);
  const grid = await cachedGetJson(points.properties.forecastGridData);
  const p = grid.properties;
  for (const k of ["waveHeight", "wavePeriod", "windSpeed", "windDirection"]) if (!p[k]) throw new Error("'" + k + "'");

  const hM = nwsValue(p.waveHeight, targetUtc);           // meters
  const period = nwsValue(p.wavePeriod, targetUtc);       // seconds
  const windKmh = nwsValue(p.windSpeed, targetUtc);       // km/h
  const windDir = nwsValue(p.windDirection, targetUtc);   // degrees

  const hb = breakingHeightFt(hM, period) * exposure;
  return {
    source: "NWS (api.weather.gov) + NOAA tides",
    surf_min_ft: pyRound(hb * 0.8, 1),
    surf_max_ft: pyRound(hb, 1),
    period_s: period ? pyRound(period, 1) : null,
    period_is_int: Number.isInteger(period),
    wind_mph: pyRound((windKmh || 0) * KMH_TO_MPH, 1),
    wind_dir: windDir,
    tide_ft: null,  // filled by caller via NOAA
  };
}

// Total precipitation (mm) in the 72 h before target. null on failure.
async function fetchRain72h(lat, lon, target, tz = TZ) {
  try {
    const data = await cachedGetJson(
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lat}&longitude=${lon}` +
      "&hourly=precipitation&past_days=3&forecast_days=7" +
      `&timezone=${tz.replace(/\//g, "%2F")}`);
    const times = data.hourly.time, precip = data.hourly.precipitation;
    const start = target - 72 * HOUR;
    let total = 0.0;
    for (let i = 0; i < Math.min(times.length, precip.length); i++) {
      const t = parseNaive(times[i]), p = precip[i];
      if (start <= t && t <= target && p !== null) total += p;
    }
    return pyRound(total, 1);
  } catch (_) {
    return null;
  }
}

// ----------------------------------------------------------------------
// Verdict logic
// ----------------------------------------------------------------------
const GO = "GO", MAYBE = "MAYBE", NO_GO = "NO GO";

/*
 * Returns [verdict, reasons, whitewashOk, greenOk].
 *
 * Scoring model: hard vetoes (rain, too big, blown out) are immediate NO GO.
 * Everything else accumulates *penalties*: independent "meh" factors like
 * chop, high tide, or mushy windswell. One penalty = MAYBE. Two or more
 * compound into NO GO, because a choppy day AND a high tide is genuinely a
 * bad session, even though neither alone would stop you.
 */
function judge(cond, rainMm, offshoreDir, isBeachbreak = true, swellDir = null) {
  const reasons = [];
  let whitewashOk = true, greenOk = true, veto = false, penalties = 0;
  let wwPenalties = 0;  // penalties that specifically degrade the whitewash zone

  const h = cond.surf_max_ft, hMin = cond.surf_min_ft;
  const H = pyStr(h), HMIN = pyStr(hMin);

  // --- Water quality (absolute veto) ---
  if (rainMm === null) {
    reasons.push("⚠ Couldn't verify rainfall — check beach water quality before going.");
  } else if (rainMm >= TH.rain_72h_mm) {
    veto = true; whitewashOk = greenOk = false;
    reasons.push(`✗ ${pyStr(rainMm)} mm of rain in the 72 h before this time — LA's post-rain ` +
      "water-quality rule says stay out (runoff bacteria).");
  } else {
    reasons.push(`✓ Dry enough: only ${pyStr(rainMm)} mm of rain in the prior 72 h.`);
  }

  // --- Wave height ---
  if (h < TH.flat_below_ft) {
    penalties += 1; wwPenalties += 1; greenOk = false;
    reasons.push(`~ Very small (${HMIN}–${H} ft): even the whitewash may be too weak to push you.`);
  } else if (h <= TH.go_max_ft) {
    reasons.push(`✓ ${HMIN}–${H} ft: ideal beginner size for whitewash and small green waves.`);
  } else if (h <= TH.maybe_max_ft) {
    penalties += 1; greenOk = false;
    reasons.push(`~ ${HMIN}–${H} ft: whitewash is rideable but heavy; green waves are beyond beginner level today.`);
  } else {
    veto = true; whitewashOk = greenOk = false;
    reasons.push(`✗ ${HMIN}–${H} ft: too big — punishing paddle-out zone and powerful foam.`);
  }

  // --- Swell character ---
  const p = cond.period_s ?? null;
  const P = pyStr(p, !!cond.period_is_int);
  const wmph = cond.wind_mph;
  if (p && p >= TH.long_period_s && h >= TH.long_period_min_ft) {
    penalties += 1; greenOk = false;
    reasons.push(`~ Long-period swell (${P} s): each wave carries more power than the height suggests.`);
  } else if (p && p <= TH.short_period_s && wmph >= TH.short_period_wind_mph) {
    penalties += 1; wwPenalties += 1; greenOk = false;
    reasons.push(`~ Short-period windswell (${P} s) with wind on it: disorganized, mushy foam that ` +
      "shoves you sideways instead of pushing you to shore.");
  }

  // --- Wind ---
  const wdir = cond.wind_dir ?? null;
  const offshore = wdir !== null && angDiff(wdir, offshoreDir) <= 67.5;
  const windDesc = wdir !== null ? `${pyStr(wmph)} mph from ${compass(wdir)}` : `${pyStr(wmph)} mph`;
  if (offshore && wmph <= TH.wind_maybe_mph) {
    reasons.push(`✓ Wind ${windDesc} — offshore, grooming the waves clean.`);
  } else if (wmph <= TH.wind_calm_mph) {
    reasons.push(`✓ Wind ${windDesc} — light enough for clean conditions.`);
  } else if (wmph <= TH.wind_maybe_mph) {
    penalties += 1; greenOk = false;
    reasons.push(`~ Wind ${windDesc} — choppy surface; green faces will crumble and foam gets lumpy.`);
  } else {
    veto = true; whitewashOk = greenOk = false;
    reasons.push(`✗ Wind ${windDesc} — blown out.`);
  }

  // --- Tide ---
  const t = cond.tide_ft ?? null;
  const T = pyStr(t);
  let lowTidePenalty = false;
  if (t !== null) {
    if (t >= TH.tide_high_ft) {
      penalties += 1; wwPenalties += 1; greenOk = false;
      reasons.push(`~ High tide (${T} ft): the whitewash zone gets deep and waves dump on the ` +
        "sand instead of rolling — bad for exactly your kind of session.");
    } else if (t <= TH.tide_low_ft) {
      penalties += 1;
      lowTidePenalty = true;  // may be absorbed by the closeout block below
      reasons.push(`~ Negative low tide (${T} ft): drained-out.`);
    } else if (t > TH.closeout_tide_max_ft) {
      // Only call it "normal" when it's clear of the closeout risk band;
      // the closeout block handles all low-tide messaging below.
      reasons.push(`✓ Tide ${T} ft — in the normal range.`);
    }
  }

  // --- Closeout risk (beachbreaks only) ---
  // Confirmed from a real session (Jul 19, SM South): at a spring low the
  // waves broke hard, fast, and right ON the sand: a low-tide shorebreak
  // closeout. That's a WATER-DEPTH phenomenon: too little water over the bar,
  // so waves stay unbroken until the shallow sand and then dump top-to-bottom
  // all at once. It happens whatever the swell period, so LOW TIDE ALONE is
  // enough to kill green waves here. Period/size/direction only make it worse.
  if (isBeachbreak && t !== null) {
    const cSize = h <= TH.closeout_size_max_ft;
    const cPeriod = p !== null && p >= TH.closeout_period_min_s;
    const cDir = swellDir !== null && swellDir >= 180 && swellDir <= 215;  // optional; often missing
    const amplifiers = (cSize ? 1 : 0) + (cPeriod ? 1 : 0) + (cDir ? 1 : 0);

    if (t <= TH.closeout_tide_low_ft) {
      // Genuinely low / drained tide: shorebreak closeouts, no rideable
      // face. This alone ends green-wave prospects on a beachbreak.
      greenOk = false;
      if (!lowTidePenalty) penalties += 1;
      reasons.push(`✗ Low-tide shorebreak (${T} ft): too little water over the sand, so waves ` +
        "break hard and fast right at the shore, all at once — no rideable face. " +
        "This is what emptied the lineup; no green waves at this tide.");
    } else if (t <= TH.closeout_tide_max_ft && amplifiers >= 1) {
      // Marginal low tide with at least one aggravator: real risk, downgrade.
      greenOk = false;
      if (!lowTidePenalty) penalties += 1;
      reasons.push(`✗ Closeout risk: low tide (${T} ft) at ${HMIN}–${H} ft — likely to break ` +
        "fast and steep with little rideable face. Better once the tide fills in.");
    } else if (t <= TH.closeout_tide_max_ft) {
      // Low-ish tide, nothing else stacked: caution, but not a downgrade.
      reasons.push(`~ Tide is on the low side (${T} ft): waves may break faster and closer to ` +
        "shore than ideal. Worth watching a few sets before paddling out.");
    }
  }

  // --- Combine ---
  let verdict;
  if (veto) {
    verdict = NO_GO;
  } else if (penalties >= TH.penalties_nogo) {
    verdict = NO_GO;
    reasons.push(`✗ ${penalties} separate problems at once — each alone is survivable, ` +
      "together they make a frustrating session. Skip it.");
  } else if (penalties === 1) {
    verdict = MAYBE;
  } else {
    verdict = GO;
  }

  // Whitewash-specific call: any factor that degrades the foam zone itself
  // (weak/mushy waves, high tide) flips whitewash off when the day is not a GO.
  if (wwPenalties >= 1 && verdict !== GO) whitewashOk = false;
  if (verdict === NO_GO) whitewashOk = false;

  // Consistency rule: a MAYBE with nothing workable is really a NO GO.
  // MAYBE means "at least one of whitewash / green waves is still viable".
  if (!whitewashOk && !greenOk && verdict !== NO_GO) {
    verdict = NO_GO;
    reasons.push("✗ Neither whitewash nor green waves are workable today — that's a no.");
  }

  // Green-only mode: the headline tracks GREEN-wave quality. A hard veto still
  // vetoes; otherwise, if green waves are out, it's a NO GO no matter how good
  // the foam is, and a lone penalty that leaves green intact is just a MAYBE.
  if (GREEN_ONLY) {
    if (veto || !greenOk) verdict = NO_GO;
    else if (penalties >= TH.penalties_nogo) verdict = NO_GO;
    else if (penalties === 1) verdict = MAYBE;
    else verdict = GO;
  }

  return [verdict, reasons, whitewashOk, greenOk];
}

// ----------------------------------------------------------------------
// Per-beach pipeline
// ----------------------------------------------------------------------
async function checkBeach(beach, target) {
  const result = { name: beach.name };
  let cond = null;
  const errors = [];
  const tz = beach.tz || TZ, exposure = beach.exposure ?? 1.0;
  if (TRY_SURFLINE) {
    try { cond = await fetchSurfline(beach.surfline_spot_id, target); }
    catch (e) { errors.push(`Surfline unavailable (${e.message}); trying Open-Meteo.`); }
  }
  if (cond === null) {
    try { cond = await fetchOpenmeteo(beach.lat, beach.lon, target, beach.noaa_station || null, exposure, tz); }
    catch (e) { errors.push(`Open-Meteo failed (${e.message}); trying NWS.`); }
  }
  if (cond === null) {
    try {
      cond = await fetchNws(beach.lat, beach.lon, target, exposure, tz);
      if (beach.noaa_station) cond.tide_ft = await fetchNoaaTide(beach.noaa_station, target);
    } catch (e) {
      cond = null;
      errors.push(`NWS failed (${e.message}).`);
    }
  }
  if (cond === null) {
    Object.assign(result, { verdict: "NO DATA", reasons: errors.length ? errors : ["No forecast data available."],
      cond: null, whitewash_ok: false, green_ok: false });
    return result;
  }
  const rainMm = await fetchRain72h(beach.lat, beach.lon, target, tz);
  const [verdict, reasons, ww, gr] = judge(cond, rainMm, beach.offshore_dir ?? 60,
    beach.beachbreak ?? true, cond.swell_dir ?? null);
  Object.assign(result, { verdict, reasons: errors.concat(reasons), cond, whitewash_ok: ww, green_ok: gr });
  return result;
}

// ----------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------
const HOURS = [
  ["6", "Dawn (~6 am)"], ["7", "Early (~7 am)"], ["8", "~8 am"], ["9", "~9 am"],
  ["10", "~10 am"], ["11", "~11 am"], ["12", "Midday (~12 pm)"], ["14", "Afternoon (~2 pm)"],
  ["16", "Late afternoon (~4 pm)"], ["18", "Evening (~6 pm)"],
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dateOptions() {
  const now = nowLa(), out = [];
  for (let i = 0; i < FORECAST_DAYS; i++) {
    const d = new Date(now + i * 86400000);
    const value = d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" :
      DAYS[d.getUTCDay()] + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
    out.push({ value, label });
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;").replace(/'/g, "&#39;");
}

function renderResult(r) {
  const c = r.cond;
  let html = '<section class="beach"><div class="beach-head"><h2>' + escapeHtml(r.name) + "</h2>" +
    '<span class="badge ' + r.verdict.replace(/ /g, "") + '">' + escapeHtml(r.verdict) + "</span></div>";
  if (c) {
    html += '<div class="subverdicts">' +
      (GREEN_ONLY ? "" : '<span class="' + (r.whitewash_ok ? "yes" : "no") + '">whitewash</span>') +
      '<span class="' + (r.green_ok ? "yes" : "no") + '">green waves</span></div>';
  }
  html += '<ul class="reasons">' + r.reasons.map((x) => "<li>" + escapeHtml(x) + "</li>").join("") + "</ul>";
  if (c) {
    html += '<div class="numbers">' + pyStr(c.surf_min_ft) + "&ndash;" + pyStr(c.surf_max_ft) + " ft" +
      (c.period_s ? " &middot; " + pyStr(c.period_s, !!c.period_is_int) + " s swell period" : "") +
      " &middot; wind " + pyStr(c.wind_mph) + " mph" +
      (c.swell_dir !== undefined && c.swell_dir !== null ? " &middot; swell " + c.swell_dir + "&deg;" : "") +
      (c.tide_ft !== null && c.tide_ft !== undefined ? " &middot; tide " + pyStr(c.tide_ft) + " ft" : "") +
      " &middot; source: " + escapeHtml(c.source) + "</div>";
  }
  return html + "</section>";
}

async function setup() {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const dates = dateOptions();
  const selDate = params.get("date"), selHour = params.get("hour"), selBeach = params.get("beach") || "all";
  let beaches = [];
  try { beaches = await loadBeaches(); }
  catch (e) { $("results").innerHTML = '<p class="loading">Could not load beaches.json (' + escapeHtml(e.message) + ").</p>"; }

  $("beach").innerHTML = '<option value="all">All beaches</option>' +
    beaches.map((b) => '<option value="' + escapeHtml(b.name) + '">' + escapeHtml(b.name) + "</option>").join("");
  $("date").innerHTML = dates.map((d) => '<option value="' + d.value + '">' + d.label + "</option>").join("");
  $("hour").innerHTML = HOURS.map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("");
  $("beach").value = selBeach;
  $("date").value = selDate || dates[0].value;
  $("hour").value = selHour || "9";

  async function run(dateStr, hourStr, beachSel) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || ""), hr = Number(hourStr);
    if (!m || !Number.isInteger(hr) || hr < 0 || hr > 23) { $("results").innerHTML = ""; return; }
    const target = Date.UTC(+m[1], +m[2] - 1, +m[3], hr);
    const chosen = beaches.filter((b) => beachSel === "all" || b.name === beachSel);
    $("results").innerHTML = '<p class="loading">Checking the surf&hellip;</p>';
    const results = await Promise.all(chosen.map((b) => checkBeach(b, target)));
    $("results").innerHTML = results.map(renderResult).join("");
  }

  $("picker").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = new URLSearchParams({ beach: $("beach").value, date: $("date").value, hour: $("hour").value });
    history.replaceState(null, "", "?" + q.toString());
    run($("date").value, $("hour").value, $("beach").value);
  });
  if (selDate && selHour) run(selDate, selHour, selBeach);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { pyRound, pyStr, judge, checkBeach, fetchOpenmeteo, fetchNws, fetchNoaaTide, fetchRain72h,
    breakingHeightFt, naiveToUtc, dateOptions, renderResult, setFetch: (f) => { fetchImpl = f; } };
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
}
