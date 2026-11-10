// Save path — a bulk change must go up in batches, survive a transient failure, and when it
// does fail report the real error plus how many rows never saved (the 940-row run that died
// after 309 left the other ~635 only in the open tab).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'allyway.html'), 'utf8');
const start = html.indexOf('let _saveT=null');
const end = html.indexOf('function setSave(m)', start);
assert.ok(start > 0 && end > start, 'save block not found');
const src = html.slice(start, end);

function harness(putRecords) {
  const calls = [];
  const stale = [];
  const ctx = {
    console: { error() {} },
    setTimeout: f => { f(); return 0; },   // skip the retry back-off
    clearTimeout() {},
    document: { getElementById: () => null },
    window: { NelnetStorage: { putRecords: async (rows, opts) => { calls.push({ rows, opts }); return putRecords(calls.length, rows, opts); } } },
    state: null, statsCache: {},
    setSave() {}, invalidateRows() {}, writeSummary() {}, computeSummary: () => ({}),
  };
  ctx.NS = () => ctx.window.NelnetStorage;
  vm.createContext(ctx);
  // The empty-array baselines stand in for snapshotSaved() having run on an empty source
  new vm.Script(src + `
;_savedXcats='[]'; _savedPeople='[]';
globalThis.api={saveNow,errText,putRetry,saved:()=>({d:_savedDisp,m:_savedManual}),isStale:()=>_stale};`).runInContext(ctx);
  // Capture goStale arguments without touching the DOM
  new vm.Script('const _gs=goStale; goStale=function(w,u){ __stale.push([w,u]); _gs(w,u); };').runInContext(Object.assign(ctx, { __stale: stale }));
  return { ctx, calls, stale };
}
const mkState = n => ({ source: 'FACTS', dispositions: Object.fromEntries(Array.from({ length: n }, (_, i) => [`R|||u${i}`, { status: 'ok_ignore', reason: 'Best Practice' }])), manualFindings: [], xcats: [], people: [], defects: [], contrast: [] });

let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };

/* ── bulk: 250 rows → 3 calls, appended, baseline committed ── */
{
  const h = harness(async () => ({}));
  h.ctx.state = mkState(250);
  await h.ctx.api.saveNow();
  check('250 changed rows go up in 3 calls, not 250', h.calls.length === 3);
  check('batches are 100 / 100 / 50', h.calls.map(c => c.rows.length).join() === '100,100,50');
  check('bulk batches append (no replaceWhere)', h.calls.every(c => !c.opts));
  check('every row carries kind, source and dkey', h.calls.flatMap(c => c.rows).every(r => r.kind === 'disp' && r.source === 'FACTS' && r.dkey));
  check('baseline is committed after a full save', Object.keys(h.ctx.api.saved().d).length === 250);
  check('tab is not frozen after a good save', h.ctx.api.isStale() === false);
}

/* ── small save keeps the per-key replace ── */
{
  const h = harness(async () => ({}));
  h.ctx.state = mkState(3);
  await h.ctx.api.saveNow();
  check('3 changed rows still write one call each', h.calls.length === 3);
  check('small saves keep replaceWhere scoped to the one dkey', h.calls.every(c => c.opts && c.opts.replaceWhere.dkey === c.rows[0].dkey));
}

/* ── a transient failure is retried and the save still completes ── */
{
  let n = 0;
  const h = harness(async () => { if (++n === 2) { const e = new Error('network down'); e.code = 'server_error'; throw e; } return {}; });
  h.ctx.state = mkState(150);
  await h.ctx.api.saveNow();
  check('a one-off server error is retried', h.calls.length === 3);
  check('the retried save finishes and does not freeze the tab', h.ctx.api.isStale() === false && Object.keys(h.ctx.api.saved().d).length === 150);
}

/* ── a fatal failure stops, keeps what landed, and counts what did not ── */
{
  const h = harness(async n => { if (n >= 2) { const e = new Error('daily write limit'); e.code = 'rate_limited'; throw e; } return {}; });
  // rate_limited is not in the fatal list, so it is retried 3 more times before it gives up
  h.ctx.state = mkState(250);
  await h.ctx.api.saveNow();
  check('gives up after the retries are spent', h.calls.length === 1 + 4);
  check('the tab freezes', h.ctx.api.isStale() === true);
  check('the banner gets the real code and message', h.stale[0][0] === 'rate_limited: daily write limit');
  check('the banner gets how many rows never saved', h.stale[0][1] === 150);
  check('the first batch stays committed so a later save only sends the rest', Object.keys(h.ctx.api.saved().d).length === 100);
}
{
  const h = harness(async () => { const e = new Error('contains an email address'); e.code = 'pii_blocked'; throw e; });
  h.ctx.state = mkState(120);
  await h.ctx.api.saveNow();
  check('a fatal code is not retried', h.calls.length === 1);
}

/* ── error text ── */
{
  const { ctx } = harness(async () => ({}));
  const t = ctx.api.errText;
  check('code and message are both shown', t({ code: 'rate_limited', message: 'slow down' }) === 'rate_limited: slow down');
  check('a message that repeats the code is not doubled', t({ code: 'timeout', message: 'timeout' }) === 'timeout');
  check('code alone', t({ code: 'forbidden' }) === 'forbidden');
  check('message alone', t(new Error('boom')) === 'boom');
  check('nothing at all still names something', t(undefined) === 'unknown error');
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
