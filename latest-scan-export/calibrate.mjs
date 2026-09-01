import fetch from 'node-fetch';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// Rule-history calibration pull (READ-ONLY).
//
// Pulls the last N successful scans for ONE source and reduces each to a
// rule-level summary — rule key/title/severity + instance & page counts. It does
// NOT emit URLs, HTML snippets, or component titles, so the output is safe to
// share for tuning the "how many absent scans = truly fixed" threshold.
//
// Usage:
//   node calibrate.mjs <API_KEY> "Exact Source Title"
//   node calibrate.mjs <API_KEY> "Exact Source Title" --scans=8
//   node calibrate.mjs <API_KEY> "Exact Source Title" --include-contrast
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.argv[2];
const SOURCE  = process.argv[3];
const args    = process.argv.slice(4);
const SCANS   = (() => {
  const n = parseInt(args.find(a => a.startsWith('--scans='))?.split('=')[1] ?? '', 10);
  return Number.isFinite(n) && n >= 2 ? n : 6;
})();
const INCLUDE_CONTRAST = args.includes('--include-contrast');

if (!API_KEY || !SOURCE) {
  console.error('Usage: node calibrate.mjs <API_KEY> "Exact Source Title" [--scans=6] [--include-contrast]');
  process.exit(1);
}

const BASE    = 'https://arc.vispero.com/api';
const HEADERS = { accept: 'application/json', 'api-key': API_KEY };
const CONTRAST_CRITERIA = new Set(['1.4.3', '1.4.11']);   // matches index.js
const REQUEST_TIMEOUT_MS = 45000;
const MIN_PAGE_SIZE = 10;
const MAX_SAME_SIZE_RETRIES = 2;

const log = (...a) => console.log('[cal]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ruleMap = {};

async function loadRules() {
  const res = await fetch(`${BASE}/v1/tests`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Failed to load rules: ${res.status} ${res.statusText}`);
  for (const r of await res.json()) ruleMap[r.key] = r;
  log(`Rules loaded: ${Object.keys(ruleMap).length}`);
}

async function resolveSourceId(title) {
  let offset = 0;
  const all = [];
  while (true) {
    const res = await fetch(`${BASE}/v2/datasources?limit=500&offset=${offset}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch datasources: ${res.status} ${res.statusText}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < 500) break;
    offset += page.length;
  }
  const hit = all.find(s => s.title === title);
  if (!hit) {
    console.error(`\nSource "${title}" not found. Available titles (first 30):`);
    for (const s of all.slice(0, 30)) console.error(`  • ${s.title}`);
    process.exit(1);
  }
  return hit.id;
}

async function getRecentScans(sourceId, limit) {
  const url = `${BASE}/v1/scans/${sourceId}?status=success&limit=${limit}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Failed to get scans: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function isTransient(err) {
  return err.code === 'ERR_STREAM_PREMATURE_CLOSE'
    || err.name === 'TimeoutError' || err.name === 'AbortError'
    || err.code === 'ECONNRESET' || err.code === 'UND_ERR_SOCKET';
}

// Resilient paged findings fetch — same shrink-on-drop strategy as index.js.
async function getScanFindings(scanId) {
  let offset = 0, limit = 100;
  const all = [];
  pages: while (true) {
    let data = null, tries = 0;
    while (true) {
      try {
        const res = await fetch(`${BASE}/v1/scans/${scanId}/findings?offset=${offset}&limit=${limit}`,
          { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        data = await res.json();
        break;
      } catch (err) {
        if (!isTransient(err)) { console.warn(`  stop at ${offset}: ${err.message}`); break pages; }
        if (tries < MAX_SAME_SIZE_RETRIES) { tries++; await sleep(500 * tries); continue; }
        if (limit > MIN_PAGE_SIZE) { limit = Math.max(MIN_PAGE_SIZE, Math.floor(limit / 2)); tries = 0; continue; }
        console.warn(`  give up at ${offset}`); break pages;
      }
    }
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < limit) break;
    offset += data.length;
  }
  return all;
}

function isContrast(f) {
  const rule = ruleMap[f.ruleKey];
  return rule?.standards?.some(s => CONTRAST_CRITERIA.has(s.criterionKey)) ?? false;
}

// URL normalize (host www-strip, trailing-slash collapse) — matches index.js so
// page counts line up with what the tool would dedupe.
function normUrl(raw) {
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.replace(/^www\./, '');
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.search = ''; u.hash = '';
    return u.toString().toLowerCase();
  } catch { return String(raw || '').toLowerCase().replace(/\/+$/, ''); }
}

function isoDate(s) {
  const d = new Date(s);
  if (isNaN(d)) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Reduce one scan's raw findings to per-rule counts (rule key is the primary
// identity; title captured alongside so we can judge which is the stabler key).
function summarizeScan(findings) {
  const rules = new Map();
  for (const f of findings) {
    const key = f.ruleKey || f.ruleTitle || '(unknown)';
    let r = rules.get(key);
    if (!r) {
      const meta = ruleMap[f.ruleKey] ?? {};
      r = {
        ruleKey: f.ruleKey || '',
        ruleTitle: (f.ruleTitle || meta.title || '').replace(/<[^>]*>/g, '').trim(),
        severity: (f.severity || meta.severity || '').toUpperCase(),
        category: f.category || meta.type?.title || '',
        instances: 0,
        _urls: new Set()
      };
      rules.set(key, r);
    }
    r.instances++;
    r._urls.add(normUrl(f.componentUrl ?? ''));
  }
  return Array.from(rules.values())
    .map(({ _urls, ...r }) => ({ ...r, pages: _urls.size }))
    .sort((a, b) => b.instances - a.instances);
}

// Local churn read — the calibration answer in miniature, printed before you
// even send the file: how often a rule vanishes then comes back with no fix.
function churnReport(scans) {
  const ordered = [...scans].sort((a, b) => a.date.localeCompare(b.date));  // oldest → newest
  const keys = new Set();
  for (const s of ordered) for (const r of s.rules) keys.add(r.ruleKey || r.ruleTitle);
  const present = k => ordered.map(s => s.rules.some(r => (r.ruleKey || r.ruleTitle) === k));

  let stable = 0, flapping = 0, reappeared = 0;
  const flappers = [];
  for (const k of keys) {
    const p = present(k);
    if (p.every(Boolean)) { stable++; continue; }
    flapping++;
    // gap = present, then absent ≥1, then present again → a false "fixed" if we'd trusted 1 absence
    let sawPresent = false, sawGapAfter = false, back = false;
    for (const v of p) {
      if (v && !sawPresent) sawPresent = true;
      else if (!v && sawPresent) sawGapAfter = true;
      else if (v && sawGapAfter) back = true;
    }
    if (back) { reappeared++; flappers.push(k); }
  }

  console.log('\n──────── churn summary (no fixes were made, so every gap is noise) ────────');
  console.log(`Scans analyzed : ${ordered.length}  (${ordered[0]?.date} → ${ordered.at(-1)?.date})`);
  console.log(`Distinct rules : ${keys.size}`);
  console.log(`Present in ALL : ${stable}  (stable core)`);
  console.log(`Flapping       : ${flapping}  (present in only some scans)`);
  console.log(`Vanish→return  : ${reappeared}  ← these would be FALSE "fixed" at a 1-absence threshold`);
  if (flappers.length) {
    console.log('\nRules that disappeared then came back (candidates the threshold must absorb):');
    for (const k of flappers.slice(0, 25)) {
      const marks = present(k).map(v => v ? '●' : '·').join(' ');
      console.log(`  ${marks}  ${k}`);
    }
    if (flappers.length > 25) console.log(`  … and ${flappers.length - 25} more`);
  }
  console.log('Legend: oldest → newest, ● present · absent\n');
}

// Per-scan page-set overlap — counts only, never the URLs themselves. Answers
// "does the crawl cover the same pages each month, or does it wander?" If shared
// is low while added/dropped are high, cross-scan rule diffing is measuring crawl
// coverage, not remediation.
function urlOverlap(urlSets) {
  const chrono = [...urlSets].sort((a, b) => a.date.localeCompare(b.date));
  const rows = [];
  for (let i = 0; i < chrono.length; i++) {
    const cur = chrono[i].set;
    if (i === 0) { rows.push({ date: chrono[i].date, urls: cur.size, shared: null, added: null, dropped: null, jaccard: null }); continue; }
    const prev = chrono[i - 1].set;
    let shared = 0;
    for (const u of cur) if (prev.has(u)) shared++;
    const added = cur.size - shared;
    const dropped = prev.size - shared;
    const union = cur.size + prev.size - shared;
    rows.push({ date: chrono[i].date, urls: cur.size, shared, added, dropped, jaccard: union ? +(shared / union).toFixed(2) : null });
  }
  return rows;
}

function printUrlStability(rows) {
  console.log('\n──────── page-set stability (are the same pages scanned each time?) ────────');
  console.log('date        urls  shared  added  dropped  overlap');
  for (const r of rows) {
    const p = (v, w) => String(v ?? '—').padStart(w);
    console.log(`${r.date}  ${p(r.urls, 4)}  ${p(r.shared, 6)}  ${p(r.added, 5)}  ${p(r.dropped, 7)}  ${r.jaccard ?? '—'}`);
  }
  console.log('overlap = Jaccard vs previous scan (1.0 = identical page set, ~0 = totally different pages)\n');
}

async function run() {
  await loadRules();
  const sourceId = await resolveSourceId(SOURCE);
  log(`Source "${SOURCE}" → ${sourceId}`);

  const scanList = await getRecentScans(sourceId, SCANS);
  if (scanList.length < 2) { console.error('Need at least 2 successful scans to calibrate.'); process.exit(1); }
  log(`Found ${scanList.length} successful scan(s); pulling findings for each…`);

  const scans = [];
  const urlSets = [];   // parallel to scans; kept in-memory only, never written (privacy)
  for (const s of scanList) {
    process.stdout.write(`  scan ${s.scanId} (${isoDate(s.date)})… `);
    const raw = await getScanFindings(s.scanId);
    const kept = INCLUDE_CONTRAST ? raw : raw.filter(f => !isContrast(f));
    const rules = summarizeScan(kept);
    const urls = new Set(kept.map(f => normUrl(f.componentUrl ?? '')).filter(Boolean));
    console.log(`${raw.length} findings → ${rules.length} rules, ${urls.size} urls${INCLUDE_CONTRAST ? '' : ` (${raw.length - kept.length} contrast excluded)`}`);
    scans.push({
      scanId: s.scanId,
      date: isoDate(s.date),
      componentsScanned: s.componentsScanned ?? null,
      totalInstances: kept.length,
      ruleCount: rules.length,
      urlCount: urls.size,
      rules
    });
    urlSets.push({ date: isoDate(s.date), set: urls });
  }

  const urlStability = urlOverlap(urlSets);   // counts only — no URLs leave the machine

  const out = {
    source: SOURCE,
    contrastExcluded: !INCLUDE_CONTRAST,
    scanCount: scans.length,
    urlStability,
    scans
  };
  const folder = join(__dirname, 'calibration');
  mkdirSync(folder, { recursive: true });
  const safe = SOURCE.replace(/[:\\/?*[\]]/g, ' ').trim();
  const path = join(folder, `${safe} - rule-history.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));

  printUrlStability(urlStability);
  churnReport(scans);
  log(`✅ Wrote: ${path}`);
  log('Send me that JSON — it contains only rule names + counts per scan, no URLs/HTML.');
}

run().catch(err => { console.error('❌', err); process.exit(1); });
