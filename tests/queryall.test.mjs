// Tests for queryAll() in ../allyway.html — the store read path.
// Extracts the real shipped function and runs it against a stub that reproduces Rideshare's
// pagination, including the cursor bug that lost triage. Run: node tests/queryall.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

// --- pull the live read path out of the app, so this tests shipped code, not a copy ---
const html = readFileSync(join(here, '..', 'allyway.html'), 'utf8');
const from = html.indexOf('let _rows=null');
const to = html.indexOf('/* ── Remember last view');
const src = from > -1 && to > from ? html.slice(from, to) : '';
for (const needed of ['function readAllRows', 'async function queryAll', 'function invalidateRows']) {
  if (!src.includes(needed)) {
    console.log(`FAIL could not extract "${needed}" from allyway.html — did the read path move?`);
    process.exit(1);
  }
}

/* Rideshare's record store, as measured on 2026-09-03. An UNFILTERED read is a plain range
   scan: cursor lands on the last row RETURNED. A FILTERED read scans a fixed ~720-row window,
   returns up to `limit` matches from it, then parks the cursor at the end of the WINDOW — so
   every match found past the limit inside that window is skipped for good. */
const WINDOW = 720;
function makeStore(rows) {
  let calls = 0;
  return {
    get calls() { return calls; },
    queryData({ limit = 100, filter, cursor }) {
      calls++;
      const start = cursor ? Number(cursor) : 0;
      if (start >= rows.length) return Promise.resolve({ items: [], cursor: null });
      if (!filter) {
        const end = Math.min(start + limit, rows.length);
        return Promise.resolve({
          items: rows.slice(start, end),
          cursor: end >= rows.length ? null : String(end),
        });
      }
      const end = Math.min(start + WINDOW, rows.length);
      const hits = [];
      for (let i = start; i < end; i++) {
        const d = rows[i].data;
        if (Object.keys(filter).every(k => d[k] === filter[k])) hits.push(rows[i]);
      }
      return Promise.resolve({
        items: hits.slice(0, limit),
        cursor: end >= rows.length ? null : String(end),
      });
    },
  };
}

// --- fixture shaped like the real store: 200 Propelr disp among 1110 rows, all in the window ---
const rows = [];
const push = (kind, extra) => rows.push({ id: String(rows.length), data: { kind, ...extra } });
push('summary', { source: 'Propelr' });
for (let i = 0; i < 200; i++) push('disp', { source: 'Propelr', dkey: 'rule-' + i, status: 'not_issue' });
for (let i = 0; i < 78; i++) push('disp', { source: 'ScholarNet', dkey: 'sn-' + i, status: 'fixed' });
push('manual', { source: 'Propelr', mid: 'm1' });
while (rows.length < 1110) push('scan', { source: 'Propelr', fingerprint: 'f' + rows.length });
eq('fixture size', rows.length, 1110);

// --- the OLD read path: filtered paging, limit 100. Documents the data loss. ---
async function oldQueryAll(store, filter) {
  const out = []; let cursor;
  for (let i = 0; i < 50; i++) {
    const r = await store.queryData({ limit: 100, filter, cursor });
    out.push(...(r.items || [])); cursor = r.cursor; if (!cursor) break;
  }
  return out;
}
const legacy = await oldQueryAll(makeStore(rows), { kind: 'disp', source: 'Propelr' });
eq('OLD path silently drops half of Propelr triage', legacy.length, 100);

// --- the NEW read path, evaluated straight from allyway.html ---
const store = makeStore(rows);
const { queryAll, invalidateRows } = new Function('NS', src + '; return {queryAll, invalidateRows};')(() => store);

eq('NEW path returns every Propelr disposition', (await queryAll({ kind: 'disp', source: 'Propelr' })).length, 200);
eq('NEW path returns every ScholarNet disposition', (await queryAll({ kind: 'disp', source: 'ScholarNet' })).length, 78);
eq('NEW path returns all dispositions across sources', (await queryAll({ kind: 'disp' })).length, 278);
eq('NEW path matches on a single key', (await queryAll({ kind: 'manual' })).length, 1);
eq('NEW path returns [] for no match', (await queryAll({ kind: 'nope' })).length, 0);

// one snapshot serves the concurrent reads of a single load
const before = store.calls;
await Promise.all([queryAll({ kind: 'scan' }), queryAll({ kind: 'disp' }), queryAll({ kind: 'manual' })]);
eq('concurrent reads share one pass (no extra requests)', store.calls, before);

// a write must drop the snapshot, or the next read serves stale rows
invalidateRows();
const afterInvalidate = store.calls;
await queryAll({ kind: 'disp' });
eq('invalidateRows forces a fresh pass', store.calls > afterInvalidate, true);

// newest-first order must survive, since newestByKey depends on it
const ordered = await queryAll({ kind: 'disp', source: 'Propelr' });
eq('store order preserved (newestByKey needs newest-first)',
  ordered.map(r => r.data.dkey).slice(0, 3), ['rule-0', 'rule-1', 'rule-2']);

// a failed pass must not be cached
const flaky = { n: 0, queryData() { this.n++; return this.n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ items: [], cursor: null }); } };
const q2 = new Function('NS', src + '; return queryAll;')(() => flaky);
let threw = false;
try { await q2({ kind: 'disp' }); } catch { threw = true; }
eq('a rejected pass propagates', threw, true);
eq('a rejected pass is not cached (retry re-requests)', (await q2({ kind: 'disp' })).length, 0);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
