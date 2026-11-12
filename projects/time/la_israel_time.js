/*
 * LA <-> Israel time converter: adarsharon.com/time
 *
 * Runs in the browser. Changing the time (or the date) in either city updates the
 * other one at once; the date is read in the city you set last. The browser's
 * time-zone database handles daylight saving, which the US and Israel switch on
 * different dates (the gap is 10 hours most of the year and 9 hours for a few
 * weeks in March and in October/November).
 *
 * Below the cities, a 24-hour strip shows both cities' hours side by side, with
 * working hours (WORK_HOURS) and reasonable hours for a call (AWAKE_HOURS) shaded;
 * an orange bar marks the hours that are reasonable in both cities.
 *
 * Browser version of the PythonAnywhere app la_israel_time.py (moved here Nov 2026).
 */
"use strict";

const LA = "America/Los_Angeles";
const IL = "Asia/Jerusalem";
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = ["00", "15", "30", "45"];
const ABBREV = {  // same abbreviations as Python's zoneinfo
  [LA]: { "-480": "PST", "-420": "PDT" },
  [IL]: { "120": "IST", "180": "IDT" },
};
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");

// --- time-zone helpers --------------------------------------------------------
const fmtCache = {};
function wallParts(tz, ms) {  // wall-clock fields of the instant ms in zone tz
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
// Wall time in zone tz -> {ms, offset}. Like Python's zoneinfo (fold=0), a time that
// occurs twice or is skipped at a clock change uses the offset in force before the change.
function wallToInstant(tz, y, mo, d, h, mi) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const before = tzOffsetMs(tz, naive - 86400000), after = tzOffsetMs(tz, naive + 86400000);
  const valid = (o) => tzOffsetMs(tz, naive - o) === o;
  let off = before;
  if (before !== after && !valid(before) && valid(after)) off = after;
  return { ms: naive - off, offset: off };
}
function abbrev(tz, offsetMs) {
  const key = String(Math.round(offsetMs / 60000));
  return (ABBREV[tz] && ABBREV[tz][key]) || "UTC" + (offsetMs >= 0 ? "+" : "") + offsetMs / 3600000;
}
function dateLabel(y, mo, d) {  // "%a %d %b %Y"
  return WD[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] + " " + pad2(d) + " " + MON[mo - 1] + " " + y;
}
function todayIn(tz) {
  const w = wallParts(tz, Date.now());
  return w.y + "-" + pad2(w.mo) + "-" + pad2(w.d);
}

// Same output as convert() in la_israel_time.py: ([HH, MM], note for the
// destination city, note for the source city).
function convert(dayStr, h, m, src, dst) {
  const [y, mo, d] = (dayStr || todayIn(src)).split("-").map(Number);
  if (!y || !mo || !d) throw new Error("bad date " + dayStr);
  const t = wallToInstant(src, y, mo, d, +h, +m);
  const w = wallParts(dst, t.ms);
  const shift = Math.round((Date.UTC(w.y, w.mo - 1, w.d) - Date.UTC(y, mo - 1, d)) / 86400000);
  const note = { "0": "same day", "1": "next day", "-1": "previous day" }[String(shift)] ||
    (shift > 0 ? "+" : "") + shift + " days";
  return [[pad2(w.h), pad2(w.mi)],
    dateLabel(w.y, w.mo, w.d) + " (" + note + "), " + abbrev(dst, tzOffsetMs(dst, t.ms)),
    dateLabel(y, mo, d) + ", " + abbrev(src, t.offset)];
}


const WORK_HOURS = [9, 18];   // local working hours: from 9:00 until 18:00
const AWAKE_HOURS = [7, 22];  // local hours that are fine for a call: from 7:00 until 22:00
const CITY = { la: { tz: LA, name: "Los Angeles", short: "LA" }, il: { tz: IL, name: "Israel", short: "Israel" } };

function nowLabel(tz) {  // "%a %H:%M"
  const w = wallParts(tz, Date.now());
  return WD[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()] + " " + pad2(w.h) + ":" + pad2(w.mi);
}
function isoDay(w) { return w.y + "-" + pad2(w.mo) + "-" + pad2(w.d); }
function hourKind(h) {
  if (h >= WORK_HOURS[0] && h < WORK_HOURS[1]) return "work";
  if (h >= AWAKE_HOURS[0] && h < AWAKE_HOURS[1]) return "awake";
  return "night";
}

// The 24 hours of dayStr in city fromKey, with the local hour in both cities.
function stripColumns(dayStr, fromKey) {
  const [y, mo, d] = dayStr.split("-").map(Number);
  const cols = [];
  for (let h = 0; h < 24; h++) {
    const ms = wallToInstant(CITY[fromKey].tz, y, mo, d, h, 0).ms;
    cols.push({ fromHour: h, ms, la: wallParts(LA, ms).h, il: wallParts(IL, ms).h });
  }
  return cols;
}
// Runs of consecutive columns where both cities are within AWAKE_HOURS (or, with
// kind = "work", within WORK_HOURS), as [{la: [start, end], il: [start, end]}].
function overlapRuns(cols, kind = "awake") {
  const ok = (h) => (kind === "work" ? hourKind(h) === "work" : hourKind(h) !== "night");
  const runs = [];
  let start = null;
  cols.forEach((c, i) => {
    const both = ok(c.la) && ok(c.il);
    if (both && start === null) start = i;
    if ((!both || i === cols.length - 1) && start !== null) {
      const end = both ? i : i - 1;
      runs.push({ la: [cols[start].la, (cols[end].la + 1) % 24], il: [cols[start].il, (cols[end].il + 1) % 24] });
      start = null;
    }
  });
  return runs;
}
const hh = (h) => pad2(h) + ":00";
function runText(r) { return "LA " + hh(r.la[0]) + "–" + hh(r.la[1]) + " = Israel " + hh(r.il[0]) + "–" + hh(r.il[1]); }

// --- page ---------------------------------------------------------------------
function setup() {
  const $ = (id) => document.getElementById(id);
  for (const key of ["la", "il"]) {
    $(key + "_h").innerHTML = HOURS.map((h) => '<option value="' + h + '">' + h + "</option>").join("");
    $(key + "_m").innerHTML = MINUTES.map((m) => '<option value="' + m + '">' + m + "</option>").join("");
  }
  let from = "la";        // the city whose time was set last
  let currentMs = null;   // the instant currently shown

  // Start at the current LA time, rounded down to a quarter hour.
  const w0 = wallParts(LA, Date.now());
  $("day").value = isoDay(w0);
  $("la_h").value = pad2(w0.h);
  $("la_m").value = pad2(Math.floor(w0.mi / 15) * 15);

  function update() {
    const other = from === "la" ? "il" : "la";
    $("day_label").textContent = "Date in " + CITY[from].name;
    $("err").textContent = "";
    try {
      const [[oh, om], dstNote, srcNote] = convert($("day").value, $(from + "_h").value, $(from + "_m").value, CITY[from].tz, CITY[other].tz);
      $(other + "_h").value = oh; $(other + "_m").value = om;
      $(other + "_note").textContent = dstNote; $(from + "_note").textContent = srcNote;
      const [y, mo, d] = $("day").value.split("-").map(Number);
      currentMs = wallToInstant(CITY[from].tz, y, mo, d, +$(from + "_h").value, +$(from + "_m").value).ms;
      drawStrip();
    } catch (e) {
      $("err").textContent = "Could not read the date: " + e.message;
    }
  }

  function drawStrip() {
    const day = $("day").value;
    const cols = stripColumns(day, from);
    const selHour = +$(from + "_h").value;
    const [y, mo, d] = day.split("-").map(Number);
    $("strip_title").textContent = "Hours of " + dateLabel(y, mo, d).slice(0, -5) + " in " + CITY[from].name;
    const cell = (c, key) => {
      const h = c[key];
      return '<button type="button" class="cell ' + hourKind(h) + (c.fromHour === selHour ? " sel" : "") +
        (c.fromHour % 3 === 0 ? " tick" : "") + '" data-h="' + c.fromHour + '" title="LA ' + hh(c.la) + " · Israel " + hh(c.il) + '">' + pad2(h) + "</button>";
    };
    const bar = (c) => '<span class="both' + (hourKind(c.la) !== "night" && hourKind(c.il) !== "night" ? " on" : "") + '"></span>';
    $("strip_grid").innerHTML =
      '<span class="strip-label">LA</span>' + cols.map((c) => cell(c, "la")).join("") +
      "<span></span>" + cols.map(bar).join("") +
      '<span class="strip-label">Israel</span>' + cols.map((c) => cell(c, "il")).join("");
    const work = overlapRuns(cols, "work"), awake = overlapRuns(cols, "awake");
    $("overlap").textContent = work.length
      ? "Working hours overlap: " + work.map(runText).join("; ") + "."
      : awake.length ? "Good for both: " + awake.map(runText).join("; ") + "." : "No hours that suit both cities on this day.";
  }

  function edited(city) {
    if (city !== from) {
      // Switching the city you set: keep the same moment, read the date in the new city.
      if (currentMs !== null) $("day").value = isoDay(wallParts(CITY[city].tz, currentMs));
      from = city;
    }
    update();
  }
  for (const city of ["la", "il"]) {
    for (const part of ["_h", "_m"]) $(city + part).addEventListener("change", () => edited(city));
  }
  $("day").addEventListener("change", update);
  $("strip_grid").addEventListener("click", (ev) => {
    const b = ev.target.closest("button.cell");
    if (!b) return;
    $(from + "_h").value = pad2(+b.dataset.h);
    $(from + "_m").value = "00";
    update();
  });
  $("now_btn").addEventListener("click", () => {
    const w = wallParts(CITY[from].tz, Date.now());
    $("day").value = isoDay(w);
    $(from + "_h").value = pad2(w.h);
    $(from + "_m").value = pad2(Math.floor(w.mi / 15) * 15);
    update();
  });

  const showNow = () => { $("now_la").textContent = nowLabel(LA); $("now_il").textContent = nowLabel(IL); };
  showNow();
  setInterval(showNow, 20000);
  update();
}

if (typeof module !== "undefined" && module.exports) module.exports = { convert, wallToInstant, nowLabel, stripColumns, overlapRuns, hourKind };
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
}
