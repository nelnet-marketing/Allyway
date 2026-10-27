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
  // The slice now runs past the reconciliation code into page wiring (main added people-list UI), so give it a no-op DOM
  const el = { addEventListener(){}, set innerHTML(v){}, style:{} };
  // computeSummary calls linkTarget / globalUrls, which now live further down the page
  const dispHelpers = slice('function linkTarget(', 'function pageNotes') + '\n' + slice('function globalUrls(', '/* ── Filter helpers');
  const written = [];   // what applyReconciliationEffects persists
  const ctx = { console, written, invalidateRows(){}, NS: () => ({ putRecords: async (rows) => { written.push(...rows); } }), openPeople(){}, document:{ getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], addEventListener(){} } };
  vm.createContext(ctx);
  new vm.Script(statuses + '\n' + bucket + '\n' + middle + '\n' + dispHelpers + '\n;({computeReconciliation,reopenInto,applyReconciliationEffects,written});').runInContext(ctx);
  return new vm.Script('({computeReconciliation,reopenInto,applyReconciliationEffects,written})').runInContext(ctx);
}

const { computeReconciliation, reopenInto, applyReconciliationEffects, written } =loadComputeReconciliation();

/* ── Fixtures (all on the standard stream) ───────────────────────────── */
const oldScanRows = [
  { data: { stream:'standard', fingerprint: 'A-fixed-gone',        title: 'A', pages: [1,2,3].map(n=>({url:'/'+n})) } },
  { data: { stream:'standard', fingerprint: 'B-fixed-still-there', title: 'B', pages: [1].map(n=>({url:'/'+n})) } },
  { data: { stream:'standard', fingerprint: 'C-active-gone-high',  title: 'C', pages: [1,2,3,4].map(n=>({url:'/'+n})) } },
  { data: { stream:'standard', fingerprint: 'D-untriaged-gone-low',title: 'D', pages: [1].map(n=>({url:'/'+n})) } },
  { data: { stream:'standard', fingerprint: 'F-suppressed-gone',   title: 'F', pages: [1,2].map(n=>({url:'/'+n})) } },
  { data: { stream:'standard', fingerprint: 'G-suppressed-escalate', title: 'G', pages: [1,2].map(n=>({url:'/'+n})) } },
  { data: { stream:'standard', fingerprint: 'H-suppressed-no-escalate', title: 'H', pages: [1,2,3,4,5].map(n=>({url:'/'+n})) } },
  { data: { stream:'standard', fingerprint: 'I-active-unchanged',  title: 'I', pages: [1,2].map(n=>({url:'/'+n})) } },
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

const full = computeReconciliation(oldScanRows, newScan, disp);
const r = full.standard;
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

// Per-stream split: an empty contrast stream (no old rows, no new rows) must diff cleanly to
// all-zero, not throw or bleed standard-stream fingerprints into it.
check('contrast stream is isolated from standard and empty here',
  full.contrast.confirmedFixed.length===0 && full.contrast.fixDidntTake.length===0 &&
  full.contrast.noLongerDetected.length===0 && full.contrast.newFindings.length===0 &&
  full.contrast.escalated.length===0 && full.contrast.activeBefore===0 && full.contrast.activeAfter===0);

/* ── carriedForward = the 'time saved' count: only rules that have a triage decision ─────────
   Still present and not reopened: H (suppressed, no escalation) and I (in progress). B and G were
   reopened this cycle, E is new. With no triaged set passed (old callers) every such rule counts. */
check('carriedForward with no triaged set keeps the old count (H and I)', r.carriedForward === 2);
const cf = triaged => computeReconciliation(oldScanRows, newScan, disp, triaged).standard.carriedForward;
check('both carried rules triaged → 2', cf(new Set(['H-suppressed-no-escalate','I-active-unchanged'])) === 2);
check('only one carried rule triaged → 1 (the untriaged one saved nothing)', cf(new Set(['H-suppressed-no-escalate'])) === 1);
check('nothing triaged → 0', cf(new Set()) === 0);
check('a reopened rule never counts even if triaged (B fix did not take)', cf(new Set(['B-fixed-still-there','G-suppressed-escalate'])) === 0);
check('a rule triaged only on a page (fingerprint in the set) counts', cf(new Set(['I-active-unchanged'])) === 1);

/* ── Page-level "Fixed" that comes back ──────────────────────────────────────────────────────
   Most Fixed decisions are made one page at a time (key fp|||url), and the lifecycle above only
   reads rule-level keys, so those used to stay "Fixed" while the scan still found them. */
const pg = (fp, urls) => ({ stream:'standard', fingerprint:fp, title:fp, pages: urls.map(u=>({url:u})) });
const oldP = [{ data: pg('P-mixed', ['/a','/b','/c']) }, { data: pg('Q-gone', ['/x']) }, { data: pg('R-other', ['/r']) }];
const newP = { standard: [ pg('P-mixed', ['/a','/c']), pg('R-other', ['/r']) ], contrast: [] };   // /b and Q went away, /a and /c remain
const pageFixed = new Map([['P-mixed', new Set(['/a','/b'])], ['Q-gone', new Set(['/x'])]]);   // marked Fixed on pages
const fullDispP = {
  'P-mixed|||/a': { status:'fixed' }, 'P-mixed|||/b': { status:'fixed' }, 'P-mixed|||/c': { status:'need_fix' },
  'Q-gone|||/x': { status:'fixed' }, 'R-other': { status:'not_issue' } };
const rp = computeReconciliation(oldP, newP, { 'R-other': { status:'not_issue' } }, new Set(['P-mixed','R-other']), { pageFixed, fullDisp: fullDispP }).standard;
const pItem = rp.fixDidntTake.find(i => i.fp === 'P-mixed');
check('a page marked Fixed that the new scan still finds is a "fix didn\'t take"', !!pItem && pItem.pageUrls.join() === '/a');
check('only the returned page is listed (/b is gone, so it is not)', pItem.pageCount === 1);
check('it is page-only: the rule itself had no Fixed status', pItem.pageOnly === true);
check('a Fixed page that is gone (Q) is not reopened', !has(rp.fixDidntTake, 'Q-gone'));
check('a rule that had a page reopened is not counted as time saved, even though /c has a standing decision',
  rp.carriedForward === 1);   // R-other only
const reopenedDisp = reopenInto({}, rp.fixDidntTake);
check('reopening writes the PAGE key, not the rule key', reopenedDisp['P-mixed|||/a']?.status === 'untriaged' && !('P-mixed' in reopenedDisp));
// Headline: all decisions counted, and the reopened page folded into "after".
//   before (old scan): P /a fixed, /b fixed, /c need_fix → 1 active page; Q fixed; R suppressed
check('headline counts page-level decisions (before: P active via /c)', rp.activeBefore === 1);
check('headline after: the reopened page (/a) joins /c as active → 2', rp.activeAfter === 2);
// With NO page-level fixed info supplied the behaviour is exactly what it was
const rp0 = computeReconciliation(oldP, newP, { 'R-other': { status:'not_issue' } }).standard;
check('without page data nothing new is reported (old callers unchanged)', rp0.fixDidntTake.length === 0);

/* ── A Fixed finding that was confirmed gone, then came back a later cycle ───────────────────
   The baseline no longer holds it, so presence alone reads as "new" — but a standing Fixed
   decision means the fix did not take, and leaving it Fixed hides it in the Fixed tile. */
const oldB = [{ data: pg('Z-unrelated', ['/z']) }];
const newB = { standard: [ pg('Y-fixed-returns', ['/1','/2']), pg('X-really-new', ['/1']), pg('W-supp-returns', ['/1']) ], contrast: [] };
const rb = computeReconciliation(oldB, newB, { 'Y-fixed-returns': { status:'fixed' }, 'W-supp-returns': { status:'ok_ignore' } }).standard;
check('a Fixed finding gone from the baseline but back in the new scan is a "fix didn\'t take"',
  has(rb.fixDidntTake, 'Y-fixed-returns') && !has(rb.newFindings, 'Y-fixed-returns'));
check('it reopens to untriaged, so it leaves the Fixed tile', reopenInto({}, rb.fixDidntTake)['Y-fixed-returns']?.status === 'untriaged');
check('a fingerprint with no standing decision is still reported as New', has(rb.newFindings, 'X-really-new'));
check('a suppressed finding that returns is New, never an escalation off a missing baseline',
  has(rb.newFindings, 'W-supp-returns') && rb.escalated.length === 0);
// Page-level Fixed deserves the same treatment when the rule itself dropped out of the baseline
const rbp = computeReconciliation(oldB, { standard: [ pg('V-page-returns', ['/a','/b']) ], contrast: [] }, {},
  null, { pageFixed: new Map([['V-page-returns', new Set(['/a'])]]), fullDisp: { 'V-page-returns|||/a': { status:'fixed' } } }).standard;
check('a returning page marked Fixed is reopened, not filed as New',
  rbp.fixDidntTake.find(i=>i.fp==='V-page-returns')?.pageUrls.join() === '/a' && !has(rbp.newFindings, 'V-page-returns'));

/* ── What gets written when a page is reopened ── */
await applyReconciliationEffects('S', { standard: rp, contrast: { fixDidntTake: [], escalated: [] } }, {
  'P-mixed|||/a': { status:'fixed', assignee:'Jose', since:'2026-09-01', notes:'swapped the colour', fix:'## fix text', cat:'cms' } });
const pageRow = written.find(w => w.dkey === 'P-mixed|||/a');
check("reopened page row is written untriaged with a fix-didn't-take flag", pageRow?.status === 'untriaged' && pageRow.reopenedReason === 'fix_didnt_take');
check('its notes, fix text and category are kept', pageRow.notes === 'swapped the colour' && pageRow.fix === '## fix text' && pageRow.cat === 'cms');
check('the Fixed claim, owner and age are dropped', !('assignee' in pageRow) && !('since' in pageRow));
check('no rule-level row is written for a page-only reopen', !written.some(w => w.dkey === 'P-mixed'));

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
