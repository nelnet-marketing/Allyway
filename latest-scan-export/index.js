import fetch from 'node-fetch';
import ExcelJS from 'exceljs';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WCAG_REFERENCE, WCAG_TESTS } from './data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==== Config ====
// Usage:
//   node index.js <API_KEY> "Source A, Source B"
//   node index.js <API_KEY> "Source A" --date-from=2025-01-01 --date-to=2025-01-31
//
// Without date args: exports findings from the single most recent completed scan per source.
// With date args:    exports findings from the most recent completed scan within that range.

// True only when executed as a CLI (`node index.js ...`), false when imported by tests.
const IS_CLI = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const API_KEY = process.argv[2] ?? '<hard-code your API key here>';

const SOURCES = (process.argv[3] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (IS_CLI && SOURCES.length === 0) {
  console.error('❌ Please provide one or more source titles (comma-separated) as argv[3].');
  process.exit(1);
}

const extraArgs      = process.argv.slice(4);
const DATE_FROM      = extraArgs.find(a => a.startsWith('--date-from='))?.split('=')[1];
const DATE_TO        = extraArgs.find(a => a.startsWith('--date-to='))?.split('=')[1];
const INCLUDE_DETAIL = extraArgs.includes('--include-details');
const INCLUDE_TRIAGE = extraArgs.includes('--include-triage');

// Findings-fetch tuning. --page-size sets the starting page size; on flaky scans
// (repeated premature closes) the fetcher shrinks it automatically and stays there.
const PAGE_SIZE = (() => {
  const n = parseInt(extraArgs.find(a => a.startsWith('--page-size='))?.split('=')[1] ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 100;
})();
const MIN_PAGE_SIZE        = 10;
const MAX_SAME_SIZE_RETRIES = 2;
const REQUEST_TIMEOUT_MS   = 45000;

const BASE    = 'https://arc.tpgi.com/api';
const HEADERS = { accept: 'application/json', 'api-key': API_KEY };

const CONTRAST_CRITERIA = new Set(['1.4.3', '1.4.11']);

let ruleMap = {};

function log(...args) {
  console.log('[ARC]', ...args);
}

// ==== Rules ====

async function loadRules() {
  log('Loading rules...');
  const res = await fetch(`${BASE}/v1/tests`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Failed to load rules: ${res.status} ${res.statusText}`);
  const rules = await res.json();
  for (const r of rules) ruleMap[r.key] = r;
  log(`Rules loaded: ${rules.length}`);
}

// ==== Data sources ====

async function resolveSourceIds(sourceTitles) {
  log('Resolving source IDs...');
  let offset = 0;
  const allSources = [];

  while (true) {
    const res = await fetch(`${BASE}/v2/datasources?limit=500&offset=${offset}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch datasources: ${res.status} ${res.statusText}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    allSources.push(...page);
    if (page.length < 500) break;
    offset += page.length;
  }

  const map = new Map();
  for (const s of allSources) {
    if (sourceTitles.includes(s.title)) map.set(s.title, s.id);
  }

  for (const title of sourceTitles) {
    if (!map.has(title)) console.warn(`⚠️  Source not found: "${title}"`);
  }

  log(`Resolved ${map.size} of ${sourceTitles.length} source(s)`);
  return map;
}

// ==== Scans ====

async function getLatestScan(sourceId) {
  const url = `${BASE}/v1/scans/${sourceId}?status=success&limit=1`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) { console.warn(`⚠️  Failed to get scans for source ${sourceId}: ${res.status}`); return null; }
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function getLatestScanInRange(sourceId, dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to   = new Date(dateTo + 'T23:59:59Z');
  let offset = 0;

  while (true) {
    const url = `${BASE}/v1/scans/${sourceId}?status=success&limit=50&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { console.warn(`⚠️  Failed to get scans for source ${sourceId}: ${res.status}`); return null; }
    const scans = await res.json();
    if (!Array.isArray(scans) || scans.length === 0) break;

    for (const scan of scans) {
      const d = new Date(scan.date);
      if (d > to) continue;   // scan is newer than range end, keep looking
      if (d < from) return null; // gone past range start, nothing to find
      return scan; // first scan within range (most recent)
    }

    offset += scans.length;
  }
  return null;
}

// ==== Findings ====

async function fetchFindingsPage(scanId, offset, limit) {
  const url = `${BASE}/v1/scans/${scanId}/findings?offset=${offset}&limit=${limit}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

// A dropped/stalled connection (not an HTTP error) — worth retrying/shrinking.
function isTransientError(err) {
  return err.code === 'ERR_STREAM_PREMATURE_CLOSE'
    || err.name === 'TimeoutError'   // AbortSignal.timeout fired
    || err.name === 'AbortError'
    || err.code === 'ECONNRESET'
    || err.code === 'UND_ERR_SOCKET';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function getScanFindings(scanId, fetchPage = fetchFindingsPage) {
  let offset = 0;
  let limit  = PAGE_SIZE;  // sticky: shrinks on trouble, never silently resets to 100
  const all  = [];
  const stats = { requests: 0, retries: 0 };
  const t0 = Date.now();

  pages:
  while (true) {
    let data = null;
    let sameSizeTries = 0;

    while (true) {
      try {
        stats.requests++;
        data = await fetchPage(scanId, offset, limit);
        break;
      } catch (err) {
        if (!isTransientError(err)) {
          console.warn(`⚠️  Error at offset ${offset}: ${err.message} — stopping with ${all.length} findings.`);
          break pages;
        }
        stats.retries++;
        // First try the same page size a couple times with a short backoff —
        // many drops are intermittent and clear on their own.
        if (sameSizeTries < MAX_SAME_SIZE_RETRIES) {
          sameSizeTries++;
          await sleep(500 * sameSizeTries);
          log(`  Connection dropped at offset ${offset} — retry ${sameSizeTries}/${MAX_SAME_SIZE_RETRIES} (page size ${limit})...`);
          continue;
        }
        // Persistent trouble at this size: shrink and keep the smaller size going forward.
        if (limit > MIN_PAGE_SIZE) {
          limit = Math.max(MIN_PAGE_SIZE, Math.floor(limit / 2));
          sameSizeTries = 0;
          log(`  Reducing page size to ${limit} at offset ${offset}...`);
          continue;
        }
        console.warn(`⚠️  Giving up at offset ${offset} (page size ${limit}) — returning ${all.length} findings.`);
        break pages;
      }
    }

    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < limit) break;
    offset += data.length;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`  Fetched ${all.length} findings in ${secs}s — ${stats.requests} request(s), ${stats.retries} retr${stats.retries === 1 ? 'y' : 'ies'}, final page size ${limit}`);
  return all;
}

// ==== Contrast filter ====

function isContrastFinding(finding) {
  const rule = ruleMap[finding.ruleKey];
  if (!rule) return false;
  return rule.standards?.some(s => CONTRAST_CRITERIA.has(s.criterionKey)) ?? false;
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hostname  = u.hostname.replace(/^www\./, '');
    u.pathname  = u.pathname.replace(/\/+$/, '') || '/';
    u.search    = '';
    u.hash      = '';
    return u.toString().toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

function buildContrastSummaryRows(contrastBySource) {
  const counts = new Map();

  for (const [source, findings] of contrastBySource.entries()) {
    for (const f of findings) {
      const normalized = normalizeUrl(f.componentUrl);
      const key = `${source}|||${normalized}`;
      const cur = counts.get(key) ?? {
        sourceTitle:    source,
        componentTitle: f.componentTitle,
        componentUrl:   normalized,
        contrastCount:  0
      };
      cur.contrastCount++;
      counts.set(key, cur);
    }
  }

  return Array.from(counts.values()).sort((a, b) => {
    if (a.sourceTitle !== b.sourceTitle) return a.sourceTitle.localeCompare(b.sourceTitle);
    return b.contrastCount - a.contrastCount;
  });
}

// ==== Excel helpers ====

function safeSheetName(name) {
  return name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);
}

function applyHeaderStyles(sheet) {
  sheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '150969' } };
    cell.font = { color: { argb: 'FFFFFF' }, bold: true };
  });
}

function addRowsToSheet(sheet, rows, columns) {
  rows.forEach(row => {
    const criterion = row.ruleCriteria;
    const refKey  = Object.keys(WCAG_REFERENCE).find(k => k.startsWith(criterion));
    const testKey = Object.keys(WCAG_TESTS).find(k => k.startsWith(criterion));

    const newRow = sheet.addRow({
      ...row,
      wcagReferenceLink: refKey && WCAG_REFERENCE[refKey]
        ? { text: refKey, hyperlink: `https://arc.tpgi.com${WCAG_REFERENCE[refKey]}` }
        : '',
      wcagTestLink: testKey && WCAG_TESTS[testKey]
        ? { text: testKey, hyperlink: `https://arc.tpgi.com${WCAG_TESTS[testKey]}` }
        : ''
    });

    const refColIdx  = columns.findIndex(c => c.key === 'wcagReferenceLink') + 1;
    const testColIdx = columns.findIndex(c => c.key === 'wcagTestLink') + 1;
    [newRow.getCell(refColIdx), newRow.getCell(testColIdx)].forEach(cell => {
      if (cell.value && typeof cell.value === 'object' && cell.value.text) {
        cell.font = { color: { argb: '0000FF' }, underline: true };
      }
    });
  });

  const htmlColIdx = columns.findIndex(c => c.key === 'instanceHTMLSource') + 1;
  for (let i = 2; i <= sheet.rowCount; i++) {
    sheet.getRow(i).getCell(htmlColIdx).font = { name: 'Courier New', size: 10 };
  }
}

function buildFindingsSummaryRows(perSourceRowsMap) {
  const counts = new Map();

  for (const [source, rows] of perSourceRowsMap.entries()) {
    for (const r of rows) {
      const url = normalizeUrl(r.componentUrl ?? '');
      const key = `${source}|||${r.instanceEngineKey}|||${r.ruleKey}|||${url}`;
      const cur = counts.get(key) ?? {
        sourceTitle:      source,
        componentTitle:   r.componentTitle,
        componentUrl:     url,
        engine:           r.instanceEngineKey || '',
        ruleKey:          r.ruleKey,
        ruleTitle:        r.ruleTitle || '',
        ruleCriteria:     r.ruleCriteria || '',
        ruleSeverity:     r.ruleSeverity || '',
        ruleCategory:     r.ruleCategory || '',
        instances:        0,
        ruleDescription:  r.ruleDescription || '',
        ruleComplementary: r.ruleComplementary || ''
      };
      cur.instances++;
      counts.set(key, cur);
    }
  }

  return Array.from(counts.values()).sort((a, b) => {
    if (a.sourceTitle !== b.sourceTitle) return a.sourceTitle.localeCompare(b.sourceTitle);
    if (a.componentUrl !== b.componentUrl) return a.componentUrl.localeCompare(b.componentUrl);
    if (b.instances !== a.instances) return b.instances - a.instances;
    return (a.ruleKey || '').localeCompare(b.ruleKey || '');
  });
}


// ==== Triage Report ====
// Strips HTML tags and decodes entities so rule titles/descriptions read as plain
// text (e.g. "Bad ARIA <code>role</code>" -> "Bad ARIA role"). Tags are stripped
// BEFORE decoding so decoded "&lt;ul&gt;" survives as literal "<ul>".
export function sanitizeText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Matches formatScanDate's UTC-of-local-parse behavior, output as YYYY-MM-DD.
export function isoDateFromScan(isoString) {
  const d = new Date(isoString);
  if (isNaN(d)) return '';
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

// Groups findings by rule (across all sources), with one child per URL beneath.
// Sorted Severity -> Category -> total instances desc. Children sorted by URL.
export function buildTriageGroups(perSourceRowsMap, scanInfoMap) {
  const sourceDate = new Map();
  for (const [src, info] of scanInfoMap.entries()) sourceDate.set(src, isoDateFromScan(info.date));

  const groups = new Map();
  for (const [source, rows] of perSourceRowsMap.entries()) {
    const dateStr = sourceDate.get(source) ?? '';
    for (const r of rows) {
      const key = r.ruleKey || r.ruleTitle || '';
      let g = groups.get(key);
      if (!g) {
        g = {
          ruleTitle:      sanitizeText(r.ruleTitle),
          severity:       r.ruleSeverity || '',
          category:       r.ruleCategory || '',
          engine:         r.instanceEngineKey || '',
          description:    sanitizeText(r.ruleDescription),
          totalInstances: 0,
          firstSeen:      dateStr,
          lastSeen:       dateStr,
          urls:           new Map()
        };
        groups.set(key, g);
      }
      g.totalInstances++;
      if (dateStr) {
        if (!g.firstSeen || dateStr < g.firstSeen) g.firstSeen = dateStr;
        if (!g.lastSeen  || dateStr > g.lastSeen)  g.lastSeen  = dateStr;
      }

      const url = r.componentUrl || '';
      let u = g.urls.get(url);
      if (!u) {
        u = { componentTitle: r.componentTitle || '', html: r.instanceHTMLSource || '', instances: 0 };
        g.urls.set(url, u);
      }
      u.instances++;
      if (!u.html && r.instanceHTMLSource) u.html = r.instanceHTMLSource;
    }
  }

  const SEV = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const CAT = { 'Error': 0, 'Alert': 1, 'Best Practice': 2 };
  const sevRank = s => SEV[(s || '').toUpperCase()] ?? 99;
  const catRank = c => CAT[c] ?? 98;

  return Array.from(groups.values())
    .map(g => ({
      ...g,
      pages: g.urls.size,
      children: Array.from(g.urls.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([url, u]) => ({ url, ...u }))
    }))
    .sort((a, b) =>
      sevRank(a.severity) - sevRank(b.severity) ||
      catRank(a.category) - catRank(b.category) ||
      b.totalInstances - a.totalInstances ||
      a.ruleTitle.localeCompare(b.ruleTitle)
    );
}

// Rule-first view with expandable per-URL child rows (collapsed by default),
// matching the CampusGuard "Accessibility Triage" format so downstream tooling
// picks it up by column name. Contrast findings are excluded, same as elsewhere.
export function addTriageSheet(wb, perSourceRowsMap, scanInfoMap) {
  const triageSheet = wb.addWorksheet('Triage Report');
  triageSheet.properties.outlineLevelRow = 1;
  triageSheet.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  triageSheet.columns = [
    { header: 'Rule Title',          key: 'ruleTitle',      width: 45 },
    { header: 'Severity',            key: 'severity',       width: 12 },
    { header: 'Category',            key: 'category',       width: 14 },
    { header: 'Engine',              key: 'engine',         width: 10 },
    { header: 'Status / Components', key: 'statusComp',     width: 40 },
    { header: 'HTML Source Code',    key: 'html',           width: 40 },
    { header: 'Ignored (mark Yes)',  key: 'ignored',        width: 16 },
    { header: 'Pages / Instances',   key: 'pagesInstances', width: 16 },
    { header: 'Total Instances',     key: 'totalInstances', width: 14 },
    { header: 'Description',         key: 'description',     width: 50 },
    { header: 'First Seen',          key: 'firstSeen',       width: 12 },
    { header: 'Last Seen',           key: 'lastSeen',        width: 12 },
    { header: 'Trend',               key: 'trend',           width: 20 }
  ];

  const triageGroups = buildTriageGroups(perSourceRowsMap, scanInfoMap);
  const triageHtmlColIdx = triageSheet.columns.findIndex(c => c.key === 'html') + 1;

  for (const g of triageGroups) {
    triageSheet.addRow({
      ruleTitle:      g.ruleTitle,
      severity:       g.severity,
      category:       g.category,
      engine:         g.engine,
      statusComp:     'New',
      pagesInstances: g.pages,
      totalInstances: g.totalInstances,
      description:    g.description,
      firstSeen:      g.firstSeen,
      lastSeen:       g.lastSeen,
      trend:          g.lastSeen ? `${g.lastSeen}: ${g.totalInstances}` : `${g.totalInstances}`
    });

    for (const c of g.children) {
      const childRow = triageSheet.addRow({
        ruleTitle:      `  ↳ ${c.url}`,
        statusComp:     c.componentTitle,
        html:           c.html,
        pagesInstances: c.instances
      });
      childRow.outlineLevel = 1;
      childRow.hidden = true;
      childRow.getCell(triageHtmlColIdx).font = { name: 'Courier New', size: 10 };
    }
  }

  applyHeaderStyles(triageSheet);
  return triageSheet;
}

function formatScanDate(isoString) {
  const d = new Date(isoString);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${mm}_${dd}_${yyyy}`;
}

// Filename suffix reflecting which opt-in tabs were included, so test runs with
// different flags don't overwrite each other. Empty (unchanged filename) when
// neither flag is set, preserving the default output.
export function tagSuffix(includeDetail, includeTriage) {
  const parts = [];
  if (includeDetail) parts.push('detailed');
  if (includeTriage) parts.push('triage');
  return parts.length ? ` - ${parts.join('-')}` : '';
}

function resolveOutputPath(scanInfoMap) {
  const dates = Array.from(scanInfoMap.values())
    .map(i => new Date(i.date))
    .filter(d => !isNaN(d));
  const latestDate = dates.length > 0
    ? new Date(Math.max(...dates.map(d => d.getTime())))
    : new Date();
  const dateStr = formatScanDate(latestDate.toISOString());
  const suffix = tagSuffix(INCLUDE_DETAIL, INCLUDE_TRIAGE);

  if (SOURCES.length === 1) {
    const source = SOURCES[0];
    const folder = join(__dirname, 'ARC Reports', source);
    mkdirSync(folder, { recursive: true });
    return join(folder, `${source} - ${dateStr}${suffix}.xlsx`);
  } else {
    const label = SOURCES.join(', ');
    const folder = join(__dirname, 'ARC Reports', 'Multiple Sources');
    mkdirSync(folder, { recursive: true });
    return join(folder, `${label} - ${dateStr}${suffix}.xlsx`);
  }
}

async function writeWorkbook(perSourceRowsMap, scanInfoMap, contrastBySource) {
  const wb = new ExcelJS.Workbook();

  // --- Scan Info sheet ---
  const infoSheet = wb.addWorksheet('Scan Info');
  infoSheet.columns = [
    { header: 'Source',              key: 'sourceName',         width: 30 },
    { header: 'Scan ID',             key: 'scanId',             width: 38 },
    { header: 'Scan Date',           key: 'date',               width: 22 },
    // ARC's scan.findingsCount is the number of distinct rule types that fired, not instances.
    { header: 'Rule Types',          key: 'findingsCount',      width: 12 },
    { header: 'Total Instances',     key: 'instanceCount',      width: 16 },
    { header: 'Components Scanned',  key: 'componentsScanned',  width: 20 }
  ];
  for (const info of scanInfoMap.values()) infoSheet.addRow(info);
  applyHeaderStyles(infoSheet);

  // --- Contrast Summary sheet ---
  const contrastSheet = wb.addWorksheet('Contrast Summary');
  contrastSheet.columns = [
    { header: 'Component',               key: 'componentTitle', width: 30 },
    { header: 'URL',                     key: 'componentUrl',   width: 50 },
    { header: 'Contrast Findings Count', key: 'contrastCount',  width: 22 }
  ];
  buildContrastSummaryRows(contrastBySource).forEach(r => contrastSheet.addRow(r));
  applyHeaderStyles(contrastSheet);

  // --- Findings Summary sheet ---
  const findingsSummarySheet = wb.addWorksheet('Findings Summary');
  findingsSummarySheet.columns = [
    { header: 'Component',      key: 'componentTitle',    width: 30 },
    { header: 'URL',            key: 'componentUrl',      width: 50 },
    { header: 'Engine',         key: 'engine',            width: 10 },
    { header: 'Rule Title',     key: 'ruleTitle',         width: 40 },
    { header: 'Severity',       key: 'ruleSeverity',      width: 12 },
    { header: 'Category',       key: 'ruleCategory',      width: 14 },
    { header: 'Instances',      key: 'instances',         width: 12 },
    { header: 'Description',    key: 'ruleDescription',   width: 40 },
    { header: 'Complementary',  key: 'ruleComplementary', width: 40 }
  ];
  const findingsSummaryRows = buildFindingsSummaryRows(perSourceRowsMap);
  findingsSummaryRows.forEach(r => findingsSummarySheet.addRow(r));

  const grandTotal = findingsSummaryRows.reduce((sum, r) => sum + r.instances, 0);
  const totalRow = findingsSummarySheet.addRow({ componentTitle: 'TOTAL', instances: grandTotal });
  totalRow.font = { bold: true };

  applyHeaderStyles(findingsSummarySheet);

  // --- Triage Report sheet (opt-in via --include-triage) ---
  if (INCLUDE_TRIAGE) addTriageSheet(wb, perSourceRowsMap, scanInfoMap);

  // --- Detailed Findings sheet (opt-in via --include-details) ---
  if (INCLUDE_DETAIL) {
    const columns = [
      { header: 'Component',      key: 'componentTitle',     width: 25 },
      { header: 'URL',            key: 'componentUrl',       width: 30 },
      { header: 'Engine',         key: 'instanceEngineKey',  width: 10 },
      { header: 'Severity',       key: 'ruleSeverity',       width: 10 },
      { header: 'Category',       key: 'ruleCategory',       width: 14 },
      { header: 'Rule',           key: 'ruleTitle',          width: 25 },
      { header: 'Description',    key: 'ruleDescription',    width: 40 },
      { header: 'Complementary',  key: 'ruleComplementary',  width: 40 },
      { header: 'HTML Source Code', key: 'instanceHTMLSource', width: 40 }
    ];

    const allDetailRows = SOURCES.flatMap(src => perSourceRowsMap.get(src) ?? []);
    const detailSheet = wb.addWorksheet('Detailed Findings');
    detailSheet.columns = columns;

    allDetailRows.forEach(row => detailSheet.addRow(row));

    const htmlColIdx = columns.findIndex(c => c.key === 'instanceHTMLSource') + 1;
    for (let i = 2; i <= detailSheet.rowCount; i++) {
      detailSheet.getRow(i).getCell(htmlColIdx).font = { name: 'Courier New', size: 10 };
    }

    applyHeaderStyles(detailSheet);
  }

  const outputPath = resolveOutputPath(scanInfoMap);
  await wb.xlsx.writeFile(outputPath);
  log(`✅ Written: "${outputPath}"`);
}

// ==== Main ====

async function run() {
  try {
    if (DATE_FROM || DATE_TO) {
      log(`Date range: ${DATE_FROM ?? 'start'} → ${DATE_TO ?? 'today'}`);
    } else {
      log('Mode: most recent completed scan per source');
    }

    await loadRules();

    const sourceIdMap = await resolveSourceIds(SOURCES);

    const perSourceRowsMap = new Map();
    const scanInfoMap      = new Map();
    const contrastBySource = new Map();
    for (const src of SOURCES) {
      perSourceRowsMap.set(src, []);
      contrastBySource.set(src, []);
    }

    for (const source of SOURCES) {
      const sourceId = sourceIdMap.get(source);
      if (!sourceId) {
        log(`Skipping "${source}" — source ID not resolved`);
        continue;
      }

      log(`Getting scan for "${source}"...`);
      const scan = DATE_FROM || DATE_TO
        ? await getLatestScanInRange(sourceId, DATE_FROM ?? '1970-01-01', DATE_TO ?? new Date().toISOString().slice(0, 10))
        : await getLatestScan(sourceId);

      if (!scan) {
        log(`No completed scan found for "${source}"${DATE_FROM || DATE_TO ? ' in the specified date range' : ''}`);
        continue;
      }

      log(`Scan ${scan.scanId} — date: ${scan.date}, findings: ${scan.findingsCount}`);
      scanInfoMap.set(source, {
        sourceName:        scan.sourceName ?? source,
        scanId:            scan.scanId,
        date:              scan.date,
        findingsCount:     scan.findingsCount,
        componentsScanned: scan.componentsScanned
      });

      log(`Fetching findings...`);
      const findings = await getScanFindings(scan.scanId);
      log(`  Raw: ${findings.length}`);
      scanInfoMap.get(source).instanceCount = findings.length;

      const filtered  = findings.filter(f => !isContrastFinding(f));
      const contrast  = findings.filter(f =>  isContrastFinding(f));
      log(`  After contrast exclusion: ${filtered.length} (${contrast.length} contrast findings summarized separately)`);

      contrastBySource.get(source).push(...contrast);

      for (const f of filtered) {
        const rule = ruleMap[f.ruleKey] ?? {};
        perSourceRowsMap.get(source).push({
          sourceTitle:        source,
          componentTitle:     f.componentTitle,
          componentUrl:       normalizeUrl(f.componentUrl ?? ''),
          instanceEngineKey:  f.engineKey,
          jobDate:            f.jobDate,
          instanceLocator:    f.instanceLocator,
          instanceLocatorType:f.instanceLocatorType,
          instanceHTMLSource: f.instanceHTMLSource,
          ruleKey:            f.ruleKey,
          ruleCriteria:       rule.standards?.[0]?.criterionKey ?? '--',
          ruleTitle:          f.ruleTitle || rule.title || '',
          ruleSeverity:       f.severity  || rule.severity || '',
          ruleCategory:       f.category  || rule.type?.title || '',
          ruleDescription:    rule.description   || '',
          ruleComplementary:  rule.complementary || ''
        });
      }
    }

    await writeWorkbook(perSourceRowsMap, scanInfoMap, contrastBySource);

  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly (not when imported by tests).
if (IS_CLI) run();
