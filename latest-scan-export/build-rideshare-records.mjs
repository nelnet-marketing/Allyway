// Turns the per-source scan.json files (from `node index.js`) into Rideshare record
// payloads — the exact shapes the tool's own ingestScanToStorage() writes into NelnetStorage.
// It does NOT push (the record-collection API is reached through the Rideshare connector,
// not a local token). Output feeds the connector push in docs/rideshare-ingest.md.
//
//   node index.js                 # off VPN — generates ARC Reports/<source>/<source> - scan.json
//   node build-rideshare-records.mjs
//   -> rideshare-payload/<source>.json  +  rideshare-payload/manifest.json
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(__dirname, 'ARC Reports');
const OUT     = join(__dirname, 'rideshare-payload');

if (!existsSync(REPORTS)) { console.error('✗ "ARC Reports" not found — run `node index.js` first (off VPN).'); process.exit(1); }

// One scan.json -> the records the tool reads: kind:'scan' per defect (standard+contrast),
// plus one kind:'source' index record. Mirrors ingestScanToStorage() in allyway.html.
function recordsFor(scan) {
  const source = scan.source, scanDate = scan.scanDate || '';
  const recs = [];
  for (const sd of (scan.standard || [])) recs.push({ kind: 'scan', source, scanDate, stream: 'standard', ...sd });
  for (const sd of (scan.contrast || [])) recs.push({ kind: 'scan', source, scanDate, stream: 'contrast', ...sd });
  recs.push({ kind: 'source', source, scanDate });
  return recs;
}

// Optional source filters: --only="A, B" builds just those; --skip="C" builds all but those.
// Match on the scan's source name (case-insensitive). --only wins if both name a source.
const argv = process.argv.slice(2);
const listArg = pfx => { const a = argv.find(x => x.startsWith(pfx)); return a ? a.slice(pfx.length).split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null; };
const ONLY = listArg('--only=');
const SKIP = listArg('--skip=') || [];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sources = [];
for (const dir of readdirSync(REPORTS, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const folder = join(REPORTS, dir.name);
  const scanFile = readdirSync(folder).find(f => f.endsWith('- scan.json'));
  if (!scanFile) continue;

  let scan;
  try { scan = JSON.parse(readFileSync(join(folder, scanFile), 'utf8')); }
  catch (e) { console.warn(`  ⚠ skipped ${dir.name}: ${e.message}`); continue; }
  if (!scan.source || !Array.isArray(scan.standard)) { console.warn(`  ⚠ skipped ${dir.name}: not an Allyway scan.json`); continue; }

  const key = scan.source.toLowerCase();
  if (ONLY && !ONLY.includes(key)) continue;
  if (SKIP.includes(key)) { console.log(`  ↷ skipped ${scan.source} (--skip)`); continue; }

  const records = recordsFor(scan);
  const file = `${scan.source}.json`;
  writeFileSync(join(OUT, file), JSON.stringify({
    source: scan.source, scanDate: scan.scanDate || '',
    standardCount: (scan.standard || []).length, contrastCount: (scan.contrast || []).length,
    records
  }));
  sources.push({ source: scan.source, file, scanDate: scan.scanDate || '', recordCount: records.length });
}

sources.sort((a, b) => a.source.localeCompare(b.source));
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sources }, null, 2));

const scope = ONLY ? ` (--only)` : SKIP.length ? ` (--skip ${SKIP.length})` : '';
console.log(`✅ rideshare-payload ready${scope} — ${sources.length} source(s), ${sources.reduce((n, s) => n + s.recordCount, 0)} records total`);
console.log('   Push: see docs/rideshare-ingest.md (remove kind:scan/source/summary per source, then add_site_data).');
console.log('   Filter: --only="Bloomwell" builds one source; --skip="ScholarNet" leaves an already-triaged source untouched.');
