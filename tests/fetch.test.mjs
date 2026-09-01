// Tests for the findings-fetch retry/backoff logic in ../index.js (getScanFindings).
// Uses an injected fetchPage mock — no network. Run: node tests/fetch.test.mjs
import { getScanFindings } from '../index.js';

let fails = 0;
const assert = (label, cond) => { if (cond) console.log(`ok   ${label}`); else { fails++; console.log(`FAIL ${label}`); } };

function premature() { const e = new Error('Premature close'); e.code = 'ERR_STREAM_PREMATURE_CLOSE'; return e; }
function makeData(n) { return Array.from({ length: n }, (_, i) => ({ id: i })); }

// --- Case 1: healthy endpoint ---
{
  const DATA = makeData(250);
  let calls = 0;
  const fetchPage = async (_id, offset, limit) => { calls++; return DATA.slice(offset, offset + limit); };
  const out = await getScanFindings('s', fetchPage);
  assert('case1 got all 250', out.length === 250);
  assert('case1 request count = 3 (100,100,50)', calls === 3);
}

// --- Case 2: fails at 100 past offset 120, sticky-shrinks to 50, no data loss ---
{
  const DATA = makeData(300);
  const requestLog = [];
  const fetchPage = async (_id, offset, limit) => {
    requestLog.push({ offset, limit });
    if (offset >= 120 && limit > 50) throw premature();
    return DATA.slice(offset, offset + limit);
  };
  const out = await getScanFindings('s', fetchPage);
  assert('case2 got all 300 (no loss)', out.length === 300);
  assert('case2 no duplicates', new Set(out.map(o => o.id)).size === 300);
  const bigAfterShrink = requestLog.filter((r, i) => i > 0 && r.limit === 100 && r.offset > 200).length;
  assert('case2 sticky: stops re-trying 100 on later pages', bigAfterShrink === 0);
}

// --- Case 3: intermittent single drop clears on same-size retry (no shrink) ---
{
  const DATA = makeData(150);
  let thrownOnce = false;
  const seenLimits = new Set();
  const fetchPage = async (_id, offset, limit) => {
    seenLimits.add(limit);
    if (offset === 100 && !thrownOnce) { thrownOnce = true; throw premature(); }
    return DATA.slice(offset, offset + limit);
  };
  const out = await getScanFindings('s', fetchPage);
  assert('case3 got all 150', out.length === 150);
  assert('case3 stayed at page size 100 (no shrink)', !seenLimits.has(50));
}

// --- Case 4: total outage past an offset -> gives up gracefully, returns partial ---
{
  const DATA = makeData(400);
  const fetchPage = async (_id, offset, limit) => {
    if (offset >= 100) throw premature();
    return DATA.slice(offset, offset + limit);
  };
  const out = await getScanFindings('s', fetchPage);
  assert('case4 returns partial (100) and terminates', out.length === 100);
}

// --- Case 5: non-transient error stops immediately with what we have ---
{
  const DATA = makeData(300);
  const fetchPage = async (_id, offset, limit) => {
    if (offset >= 100) throw new Error('500 Internal Server Error');
    return DATA.slice(offset, offset + limit);
  };
  const out = await getScanFindings('s', fetchPage);
  assert('case5 stops on HTTP error, keeps 100', out.length === 100);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
