// "Why did the count change" (spec §5–8) — verifies computeReconciliation classifies every
// disposition/presence combination the spec defines, so a re-scan can never silently hide a
// broken "Fixed" claim or a suppressed finding that quietly grew into a real problem.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadComputeReconciliation() {
  const html = readFileSync(join(__dirname, '..', 'allyway.html'), 'utf8');
  const slice = (startMark, endMark) => {
    const start = html.indexOf(startMark);
    const end = html.indexOf(endMark, start);
    assert.ok(start > 0 && end > start, `markers not found: ${startMark} .. ${endMark}`);
    return html.slice(start, end);
  };
  // Three non-contiguous pieces: the status model, the block from defectFromScan through the
  // reconciliation logic (computeReconciliation needs computeSummary + defectFromScan, both
  // defined earlier in that span), and the one-line bucket() helper — concatenated so the real
  // definitions run unmodified rather than duplicated by hand (which could silently drift).
  const statuses = slice('const STATUSES = [', 'const REASONS');
  const middle = slice('function defectFromScan(sd){', 'async function adminLoadScan');
  const bucket = "const bucket = st => SMAP[st]?.bucket || 'active';\n";
  const ctx = { console };
  vm.createContext(ctx);
  new vm.Script(statuses + '\n' + bucket + '\n' + middle + '\n;({computeReconciliation});').runInContext(ctx);
  return new vm.Script('({computeReconciliation})').runInContext(ctx);
}

const { computeReconciliation } = loadComputeReconciliation();

/* ── Fixtures ─────────────────────────────────────────────────────── */
const oldScanRows = [
  { data: { fingerprint: 'A-fixed-gone',        title: 'A', pages: [1,2,3].map(n=>({url:'/'+n})) } },
  { data: { fingerprint: 'B-fixed-still-there', title: 'B', pages: [1].map(n=>({url:'/'+n})) } },
  { data: { fingerprint: 'C-active-gone-high',  title: 'C', pages: [1,2,3,4].map(n=>({url:'/'+n})) } },
  { data: { fingerprint: 'D-untriaged-gone-low',title: 'D', pages: [1].map(n=>({url:'/'+n})) } },
  { data: { fingerprint: 'F-suppressed-gone',   title: 'F', pages: [1,2].map(n=>({url:'/'+n})) } },
  { data: { fingerprint: 'G-suppressed-escalate', title: 'G', pages: [1,2].map(n=>({url:'/'+n})) } },
  { data: { fingerprint: 'H-suppressed-no-escalate', title: 'H', pages: [1,2,3,4,5].map(n=>({url:'/'+n})) } },
  { data: { fingerprint: 'I-active-unchanged',  title: 'I', pages: [1,2].map(n=>({url:'/'+n})) } },
];
const newScan = { standard: [
  { fingerprint: 'B-fixed-still-there',    title: 'B', pages: [{url:'/1'}] },
  { fingerprint: 'G-suppressed-escalate',  title: 'G', pages: [1,2,3,4,5,6].map(n=>({url:'/'+n})) },   // 2→6: +4 pages
  { fingerprint: 'H-suppressed-no-escalate', title: 'H', pages: [1,2,3,4,5,6].map(n=>({url:'/'+n})) }, // 5→6: +1, <2x
  { fingerprint: 'I-active-unchanged',     title: 'I', pages: [{url:'/1'},{url:'/2'}] },
  { fingerprint: 'E-brand-new',            title: 'E', pages: [{url:'/1'}] },
], contrast: [] };
const disp = {
  'A-fixed-gone':          { status: 'fixed' },
  'B-fixed-still-there':   { status: 'fixed' },
  'C-active-gone-high':    { status: 'need_fix' },
  // D has no disposition at all — effectively untriaged
  'F-suppressed-gone':     { status: 'ok_ignore' },
  'G-suppressed-escalate': { status: 'not_issue' },
  'H-suppressed-no-escalate': { status: 'cant_fix' },
  'I-active-unchanged':    { status: 'in_progress' },
};

const r = computeReconciliation(oldScanRows, newScan, disp);
let fails = 0;
const has = (list, fp) => list.some(i => i.fp === fp);
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };

check('confirmed fixed: disposition Fixed + absent from new scan', has(r.confirmedFixed, 'A-fixed-gone') && r.confirmedFixed.length === 1);
check("fix didn't take: disposition Fixed but still present", has(r.fixDidntTake, 'B-fixed-still-there') && r.fixDidntTake.length === 1);
check('no longer detected, high confidence (was ≥3 pages)', r.noLongerDetected.find(i=>i.fp==='C-active-gone-high')?.confidence === 'high');
check('no longer detected, low confidence (was ≤2 pages, no disposition = untriaged)', r.noLongerDetected.find(i=>i.fp==='D-untriaged-gone-low')?.confidence === 'low');
check('suppressed + absent stays silently suppressed (no event anywhere)',
  !has(r.confirmedFixed,'F-suppressed-gone') && !has(r.fixDidntTake,'F-suppressed-gone') &&
  !has(r.noLongerDetected,'F-suppressed-gone') && !has(r.escalated,'F-suppressed-gone'));
check('escalation guard fires: suppressed finding jumped +4 pages (≥3)', has(r.escalated, 'G-suppressed-escalate'));
check('escalation guard does NOT fire on a +1 page, <2x jump', !has(r.escalated, 'H-suppressed-no-escalate'));
check('an unchanged active finding produces no event',
  !has(r.confirmedFixed,'I-active-unchanged') && !has(r.fixDidntTake,'I-active-unchanged') &&
  !has(r.noLongerDetected,'I-active-unchanged') && !has(r.newFindings,'I-active-unchanged') && !has(r.escalated,'I-active-unchanged'));
check('brand-new fingerprint (not in old scan) reported as New', has(r.newFindings, 'E-brand-new'));
check('totals: nothing double-counted',
  r.confirmedFixed.length + r.fixDidntTake.length + r.noLongerDetected.length + r.newFindings.length === 5);

/* ── Headline: Active findings before vs. after, reopened items folded into "after" ────────
   Before (old scan + current dispositions): C(4,need_fix)+D(1,untriaged)+I(2,in_progress)=7 active.
   After (new scan + dispositions with B and G reopened to untriaged by this same report):
   B(1)+G(6)+I(2)+E(1)=10 active — H stays suppressed (no escalation), A/C/D are gone from the new scan. */
check('activeBefore counts only what was active on the OLD scan', r.activeBefore === 7);
check('activeAfter folds reopened (fix-didn\'t-take + escalated) items in as active', r.activeAfter === 10);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
