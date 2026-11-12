/*
 * New Papers: adarsharon.com/arxiv
 *
 * Runs entirely in the browser; every page load fetches fresh data from INSPIRE:
 *   1. the newest papers citing INSPIRE author INSPIRE_AUTHOR_ID;
 *   2. all hep-th papers from the last DAYS_BACK days, including those
 *      cross-listed to hep-th, of which only those with at least one followed
 *      author are shown.
 * The followed authors are listed in followed_authors.json next to this file.
 *
 * Browser version of the PythonAnywhere app flask_app.py (moved here Nov 2026);
 * the author matching below follows the Python code line by line.
 */
"use strict";

const INSPIRE_AUTHOR_ID = "Adar.Sharon.1";
const INSPIRE_PROFILE_URL = "https://inspirehep.net/authors/1683407";
const AUTHORS_FILE = "/projects/arxiv/followed_authors.json";
const DAYS_BACK = 30;
const NUM_CITATIONS = 3;
const INSPIRE_PAGE_SIZE = 1000;  // INSPIRE's maximum; longer result lists are fetched page by page
const INSPIRE_API = "https://inspirehep.net/api/literature";
const REQUEST_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function cleanText(value) {
  if (value === null || value === undefined || value === "" || value === false) return "";
  return String(value).split(/\s+/).filter(Boolean).join(" ");
}

function normalizeNameText(value) {
  let v = String(value).normalize("NFKD").replace(/\p{Mn}/gu, "");
  v = v.replace(/[^A-Za-z0-9]+/g, " ");
  return v.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function nameTokens(value) {
  const n = normalizeNameText(value);
  return n ? n.split(" ") : [];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

const pad2 = (n) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------
// Author matching (full names, initials allowed)
// ---------------------------------------------------------------------------

function trackedAuthorCandidatesFromCode(code) {
  const parts = code.split("_").map(normalizeNameText).filter(Boolean);
  if (parts.length < 2) return [];
  const candidates = [
    { last: parts[0], given: parts.slice(1), source: code },
    { last: parts[parts.length - 1], given: parts.slice(0, -1), source: code },
  ];
  const unique = [], seen = new Set();
  for (const c of candidates) {
    const key = JSON.stringify([c.last, c.given]);
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  return unique;
}

function buildTrackedAuthorCandidates(authors, aliases) {
  const candidates = [];
  for (const author of authors) {
    const codes = [author].concat((aliases && aliases[author]) || []);
    for (const code of codes) candidates.push(...trackedAuthorCandidatesFromCode(code));
  }
  const unique = [], seen = new Set();
  for (const c of candidates) {
    const key = JSON.stringify([c.last, c.given, c.source]);
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  return unique;
}

function parseAuthorName(name) {
  name = cleanText(name);
  if (!name) return null;
  if (name.includes(",")) {
    const i = name.indexOf(",");
    const lastTokens = nameTokens(name.slice(0, i));
    const givenTokens = nameTokens(name.slice(i + 1));
    if (!lastTokens.length) return null;
    return { last: lastTokens[lastTokens.length - 1], given: givenTokens };
  }
  const tokens = nameTokens(name);
  if (!tokens.length) return null;
  if (tokens.length === 1) return { last: tokens[0], given: [] };
  return { last: tokens[tokens.length - 1], given: tokens.slice(0, -1) };
}

function tokenMatches(expected, seen) {
  if (expected === seen) return true;
  if (expected.length === 1 && seen.startsWith(expected)) return true;
  if (seen.length === 1 && expected.startsWith(seen)) return true;
  return false;
}

function givenNamesMatch(expected, seen) {
  if (!expected.length) return true;
  if (!seen.length) return false;
  if (!tokenMatches(expected[0], seen[0])) return false;
  if (expected.length === 1 || seen.length === 1) return true;
  const shared = Math.min(expected.length, seen.length);
  for (let i = 0; i < shared; i++) {
    if (!tokenMatches(expected[i], seen[i])) return false;
  }
  if (seen.length < expected.length) return seen.every((t) => t.length === 1);
  return true;
}

function authorMatches(tracked, actual) {
  return tracked.last === actual.last && givenNamesMatch(tracked.given, actual.given);
}

function findMatchingTrackedAuthors(authorsList, candidates) {
  const matches = [];
  for (const authorName of authorsList) {
    const actual = parseAuthorName(authorName);
    if (actual === null) continue;
    for (const tracked of candidates) {
      if (authorMatches(tracked, actual)) { matches.push(cleanText(authorName)); break; }
    }
  }
  const seen = new Set(), unique = [];
  for (const m of matches) {
    const key = normalizeNameText(m);
    if (!seen.has(key)) { seen.add(key); unique.push(m); }
  }
  return unique;
}

// ---------------------------------------------------------------------------
// INSPIRE records -> papers and citations
// ---------------------------------------------------------------------------

function parseInspireDate(value, nowMs) {
  value = cleanText(value);
  const patterns = [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, /^(\d{4})-(\d{1,2})$/, /^(\d{4})$/];
  for (const re of patterns) {
    const m = value.match(re);
    if (!m) continue;
    const y = +m[1], mo = m[2] ? +m[2] : 1, d = m[3] ? +m[3] : 1;
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d) return ms;
  }
  return nowMs;  // missing or unreadable date: treated as "now", as in the Python version
}

function formatDot(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "." + pad2(d.getUTCMonth() + 1) + "." + pad2(d.getUTCDate());
}

function firstTitle(md) {
  const titles = md.titles || [];
  if (!titles.length) return "No title";
  return "title" in titles[0] ? titles[0].title : "No title";
}

function getFirstArxivId(md) {
  for (const e of md.arxiv_eprints || []) {
    const v = cleanText(e.value || "");
    if (v) return v;
  }
  return "";
}

function processRecentPapers(data, candidates, nowMs) {
  const papers = [];
  for (const hit of (data.hits && data.hits.hits) || []) {
    const md = hit.metadata || {};
    const authorsList = [];
    for (const a of md.authors || []) {
      const fullName = cleanText(a.full_name || "");
      if (fullName) authorsList.push(fullName);
    }
    const matched = findMatchingTrackedAuthors(authorsList, candidates);
    if (!matched.length) continue;
    const arxivId = getFirstArxivId(md);
    const recordId = "control_number" in md ? md.control_number : (hit.id || "");
    papers.push({
      title: cleanText(firstTitle(md)),
      authors: authorsList,
      matched_authors: matched,
      published: parseInspireDate(md.earliest_date || "", nowMs),
      id: arxivId ? "https://arxiv.org/abs/" + arxivId : "https://inspirehep.net/literature/" + recordId,
      arxiv_id: arxivId ? arxivId : String(recordId),
    });
  }
  papers.sort((a, b) => b.published - a.published);  // stable: ties keep INSPIRE order
  return papers;
}

function processCitations(data) {
  const out = [];
  for (const hit of (data.hits && data.hits.hits) || []) {
    const md = hit.metadata || {};
    const authorsData = md.authors || [];
    let authors = authorsData.slice(0, 5).map((a) => a.full_name || "");
    if (authorsData.length > 5) authors.push("et al.");
    out.push({
      title: cleanText(firstTitle(md)),
      authors: authors.map(cleanText).filter(Boolean),
      date: md.earliest_date || "",
      record_id: md.control_number || "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function formatAuthorName(author) {
  author = cleanText(author);
  if (!author.includes(",")) return author;
  const i = author.indexOf(",");
  const last = cleanText(author.slice(0, i)), given = cleanText(author.slice(i + 1));
  if (!last || !given) return author;
  return given + " " + last;
}

function formatAuthorsDisplay(list) {
  return list.map(formatAuthorName).filter(Boolean).join("; ");
}

function formatPaperHtml(p) {
  const url = escapeHtml(p.id);
  return '<article class="paper">' +
    '<div class="paper-top">' +
    '<a class="paper-id" href="' + url + '">' + escapeHtml(p.arxiv_id) + '</a>' +
    '<span class="date">' + escapeHtml(formatDot(p.published)) + '</span>' +
    '</div>' +
    '<h3 class="paper-title"><a href="' + url + '">' + escapeHtml(p.title) + '</a></h3>' +
    '<div class="meta"><span class="label">Authors</span>' + escapeHtml(formatAuthorsDisplay(p.authors)) + '</div>' +
    '</article>';
}

function formatCitationHtml(c) {
  const dateStr = c.date ? c.date.slice(0, 10) : "Unknown date";
  const link = c.record_id ? "https://inspirehep.net/literature/" + c.record_id : "https://inspirehep.net/literature";
  let authorText = "";
  if (c.authors.length) {
    const lastNames = c.authors.map((a) => (a === "et al." ? "et al." : a.split(",")[0].trim()));
    authorText = ' <span class="citation-authors">(' + escapeHtml(lastNames.join(", ")) + ')</span>';
  }
  return '<li class="citation">' +
    '<span class="date">' + escapeHtml(dateStr) + '</span> ' +
    '<a href="' + escapeHtml(link) + '">' + escapeHtml(c.title) + '</a>' +
    authorText + '</li>';
}

function renderSections(papers, citations, citationError, paperError) {
  const out = [];
  out.push('<section class="section"><h2 class="section-title">');
  out.push('New Citations <span class="date">(' + citations.length + ')</span> ');
  out.push('<a href="' + INSPIRE_PROFILE_URL + '">INSPIRE profile</a></h2>');
  if (citations.length) {
    out.push('<ul class="citation-list">' + citations.map(formatCitationHtml).join("") + '</ul>');
  } else {
    out.push('<p class="empty">' + (citationError ? "Could not load citations: " + escapeHtml(citationError) : "No recent citations found.") + '</p>');
  }
  out.push('</section>');
  out.push('<section class="section"><h2 class="section-title">');
  out.push('New Papers <span class="date">(' + papers.length + ')</span> ');
  out.push('<a href="https://arxiv.org/list/hep-th/new">arXiv hep-th</a></h2>');
  if (papers.length) {
    out.push(papers.map(formatPaperHtml).join(""));
  } else {
    out.push('<p class="empty">' + (paperError ? "Could not load papers: " + escapeHtml(paperError) : "No recent papers found.") + '</p>');
  }
  out.push('</section>');
  return out.join("");
}

// ---------------------------------------------------------------------------
// Network (retries on 429/5xx like the Python session did)
// ---------------------------------------------------------------------------

async function fetchJson(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 800 * 2 ** (i - 1)));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let resp;
      try { resp = await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
      if (resp.ok) return await resp.json();
      lastErr = new Error(new URL(url).host + " returned " + resp.status);
      if (![429, 500, 502, 503, 504].includes(resp.status)) break;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("request timed out") : e;
    }
  }
  throw lastErr;
}

function inspireUrl(params) {
  return INSPIRE_API + "?" + new URLSearchParams(params).toString();
}

function recentPapersUrl(nowMs, page = 1) {
  const start = new Date(nowMs - DAYS_BACK * 86400000).toISOString().slice(0, 10);
  return inspireUrl({
    q: "arxiv_eprints.categories:hep-th and de > " + start,  // hep-th as primary or cross-list
    sort: "mostrecent",
    size: String(INSPIRE_PAGE_SIZE),
    page: String(page),
    fields: "titles,authors.full_name,arxiv_eprints,control_number,earliest_date",
  });
}

// All pages of the recent-papers query, merged into one INSPIRE-style response.
async function fetchRecentPapers(nowMs) {
  const first = await fetchJson(recentPapersUrl(nowMs, 1));
  const total = (first.hits && first.hits.total) || 0;
  const pages = Math.ceil(total / INSPIRE_PAGE_SIZE);
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => fetchJson(recentPapersUrl(nowMs, i + 2))));
  const hits = [first, ...rest].flatMap((d) => (d.hits && d.hits.hits) || []);
  return { hits: { total, hits } };
}

function citationsUrl() {
  return inspireUrl({
    q: "refersto author " + INSPIRE_AUTHOR_ID,
    sort: "mostrecent",
    size: String(NUM_CITATIONS),
    fields: "titles,authors.full_name,control_number,earliest_date",
  });
}

function utcStamp(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) +
    " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}

async function main() {
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  const nowMs = Date.now();
  let citations = [], papers = [], citationError = "", paperError = "";
  const citationsTask = fetchJson(citationsUrl())
    .then((d) => { citations = processCitations(d); })
    .catch((e) => { citationError = e.message || String(e); });
  const papersTask = Promise.all([fetchJson(AUTHORS_FILE + "?t=" + nowMs, 1), fetchRecentPapers(nowMs)])
    .then(([cfg, d]) => {
      const candidates = buildTrackedAuthorCandidates(cfg.authors || [], cfg.aliases || {});
      papers = processRecentPapers(d, candidates, nowMs);
    })
    .catch((e) => { paperError = e.message || String(e); });
  await Promise.all([citationsTask, papersTask]);
  results.innerHTML = renderSections(papers, citations, citationError, paperError);
  status.textContent = "Fresh data fetched at " + utcStamp(Date.now()) + " UTC.";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cleanText, normalizeNameText, buildTrackedAuthorCandidates, parseAuthorName, findMatchingTrackedAuthors,
    parseInspireDate, processRecentPapers, processCitations, formatPaperHtml, formatCitationHtml,
    renderSections, recentPapersUrl, citationsUrl, formatDot, fetchRecentPapers,
  };
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
}
