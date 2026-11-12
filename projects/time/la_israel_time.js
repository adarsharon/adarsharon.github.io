/*
 * LA <-> Israel time converter: adarsharon.com/time
 *
 * Runs in the browser. The date is read in the "from" city; the browser's
 * time-zone database handles daylight saving, which the US and Israel switch
 * on different dates (so the gap is 10 hours most of the year and 9 hours for
 * a few weeks in March and in October/November).
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

function nowLabel(tz) {  // "%a %H:%M"
  const w = wallParts(tz, Date.now());
  return WD[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()] + " " + pad2(w.h) + ":" + pad2(w.mi);
}

// --- page ---------------------------------------------------------------------
function setup() {
  const $ = (id) => document.getElementById(id);
  for (const key of ["la", "il"]) {
    $(key + "_h").innerHTML = '<option value="">--</option>' + HOURS.map((h) => '<option value="' + h + '">' + h + "</option>").join("");
    $(key + "_m").innerHTML = MINUTES.map((m) => '<option value="' + m + '">' + m + "</option>").join("");
  }
  $("day").value = todayIn(LA);
  const showNow = () => { $("now_la").textContent = nowLabel(LA); $("now_il").textContent = nowLabel(IL); };
  showNow();
  setInterval(showNow, 20000);

  for (const go of ["la", "il"]) {
    $("go_" + go).addEventListener("click", () => {
      const other = go === "la" ? "il" : "la";
      const [src, dst] = go === "la" ? [LA, IL] : [IL, LA];
      $("la_note").textContent = ""; $("il_note").textContent = ""; $("err").textContent = "";
      const h = $(go + "_h").value, m = $(go + "_m").value;
      if (!h) { $("err").textContent = "Choose an hour first."; return; }
      try {
        const [[oh, om], dstNote, srcNote] = convert($("day").value, h, m, src, dst);
        $(other + "_h").value = oh; $(other + "_m").value = om;
        $(other + "_note").textContent = dstNote; $(go + "_note").textContent = srcNote;
      } catch (e) {
        $("err").textContent = "Could not parse input: " + e.message;
      }
    });
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { convert, wallToInstant, nowLabel };
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
}
