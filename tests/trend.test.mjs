// Leadership homepage trend aggregation — verifies the "as-of" merge across independently-
// scanning sources produces a sane combined total, and that the SVG chart renderer doesn't
// choke on the edge cases a real dashboard will actually hit (no data, one point).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));

function load() {
  const html = readFileSync(join(__dirname, '..', 'allyway.html'), 'utf8');
  const slice = (startMark, endMark) => {
    const start = html.indexOf(startMark);
    const end = html.indexOf(endMark, start);
    assert.ok(start > 0 && end > start, `markers not found: ${startMark}`);
    return html.slice(start, end);
  };
  const esc = "const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');\n";
  const block = slice('const MINUTES_PER_FINDING', 'async function renderLeadershipView');
  const ctx = { console };
  vm.createContext(ctx);
  new vm.Script(esc + block + '\n;({aggregateTrendRows,renderTrendChartSVG,MINUTES_PER_FINDING});').runInContext(ctx);
  return new vm.Script('({aggregateTrendRows,renderTrendChartSVG,MINUTES_PER_FINDING})').runInContext(ctx);
}

const { aggregateTrendRows, renderTrendChartSVG, MINUTES_PER_FINDING } = load();

let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };

check('locked-in time-saved rate is 3 min/finding (Teisha\'s estimate)', MINUTES_PER_FINDING === 3);

/* ── aggregateTrendRows: two sources scanning on independent schedules ─────────
   A scans at t=1 (active 10), B scans at t=2 (active 5), A rescans at t=3 (active 8, 2 confirmed
   fixed, 6 carried forward). The overall series at t=3 must reflect A's NEW value plus B's
   still-current value from t=2 — not just A's value alone. */
const rows = [
  { source:'A', scanDate:'2026-01-01', computedAt:1, active:10, confirmedFixed:0, carriedForward:0 },
  { source:'B', scanDate:'2026-02-01', computedAt:2, active:5,  confirmedFixed:0, carriedForward:0 },
  { source:'A', scanDate:'2026-03-01', computedAt:3, active:8,  confirmedFixed:2, carriedForward:6 },
];
const agg = aggregateTrendRows(rows);

check('overall series has one point per event', agg.overall.length === 3);
check('overall[0] (A only, t=1) = 10', agg.overall[0].total === 10);
check('overall[1] (A@10 + B@5, t=2) = 15', agg.overall[1].total === 15);
check('overall[2] (A rescanned to 8 + B still 5, t=3) = 13 — not just A\'s new 8', agg.overall[2].total === 13);
check('currentActive = sum of each source\'s LATEST value (8 + 5)', agg.currentActive === 13);
check('bySource splits per source correctly', agg.bySource.get('A').length === 2 && agg.bySource.get('B').length === 1);
check('totalConfirmedFixed sums across all events', agg.totalConfirmedFixed === 2);
check('totalCarriedForward sums across all events', agg.totalCarriedForward === 6);

/* ── renderTrendChartSVG: must not throw on the edge cases a real dashboard hits ── */
const empty = renderTrendChartSVG([]);
check('empty series renders a message, not a broken chart', /No trend data/.test(empty));

const onePoint = renderTrendChartSVG([{date:'2026-01-01', total:5}]);
check('a single point still renders one dot without dividing by zero', (onePoint.match(/<circle/g)||[]).length === 1);

const many = renderTrendChartSVG(agg.overall);
check('multi-point series renders one dot per point', (many.match(/<circle/g)||[]).length === agg.overall.length);
check('multi-point series renders exactly one path (single series, no extra strokes)', (many.match(/<path/g)||[]).length === 1);

/* ── Time, not load order ─────────────────────────────────────────────────────
   A past month loaded AFTER a newer one (computedAt says it was loaded last) must still plot
   before it, and "current" must be the newest scan by date. */
const late = aggregateTrendRows([
  { source:'A', scanDate:'2026-09-01', computedAt:100, active:8 },
  { source:'A', scanDate:'2026-08-01', computedAt:200, active:12 },   // loaded later, scanned earlier
]);
check('out-of-order load: overall series is in scan-date order', late.overall.map(p=>p.date).join()==='2026-08-01,2026-09-01');
check('out-of-order load: per-source series is in scan-date order', late.bySource.get('A').map(d=>d.scanDate).join()==='2026-08-01,2026-09-01');
check('out-of-order load: current active is the NEWEST scan (8), not the last loaded (12)', late.currentActive === 8);

const sameDay = aggregateTrendRows([
  { source:'A', scanDate:'2026-08-01', computedAt:1, active:10 },
  { source:'B', scanDate:'2026-08-01', computedAt:2, active:5 },
]);
check('two sources on one date collapse to one overall point with the combined total', sameDay.overall.length===1 && sameDay.overall[0].total===15 && sameDay.overall[0].sources===2);

/* ── x position follows the calendar ──
   The chart draws one point per calendar month, the latest scan in it, placed at the month start —
   scans are monthly, and an extra ad-hoc pull should not put two dots on top of each other. So the
   axis is months elapsed, and the labels name a month rather than a day. */
const xs = s => [...s.matchAll(/<circle cx="([\d.]+)"/g)].map(m=>parseFloat(m[1]));
const spaced = renderTrendChartSVG([
  {date:'2026-01-01', total:5}, {date:'2026-02-01', total:6}, {date:'2026-08-01', total:4}]);
const [x1,x2,x3] = xs(spaced);
check('dots are spaced by elapsed time (1 month vs 6 months), not evenly', (x2-x1) < (x3-x2)/3);
check('out-of-order input is still drawn left to right by date', xs(renderTrendChartSVG([{date:'2026-03-01',total:1},{date:'2026-01-01',total:2}])).every((x,i,a)=>i===0||x>a[i-1]));
check('first and last months are labelled under the line', /Jan 2026/.test(spaced) && /Aug 2026/.test(spaced));

// two scans in one month are one dot, carrying the later scan's value
const twice = renderTrendChartSVG([{date:'2026-01-05', total:9}, {date:'2026-01-27', total:4}]);
check('a second scan in the same month replaces the first rather than adding a dot',
  xs(twice).length === 1 && /Jan 2026, 4 active/.test(twice));

/* ── hover / focus tooltip ── */
const tipSvg = renderTrendChartSVG([
  {scanDate:'2026-08-01', active:1234, suppressed:500, verify:12, confirmedFixed:7, carriedForward:90},
  {scanDate:'2026-09-01', active:1100, suppressed:520, verify:30, confirmedFixed:0, carriedForward:0}]);
check('every dot is keyboard-focusable', (tipSvg.match(/class="trend-pt" tabindex="0"/g)||[]).length === 2);
check('each dot has an accessible name with month and value', /aria-label="Aug 2026, 1,234 active/.test(tipSvg));
check('tooltip shows the extra detail (suppressed, fixed, carried forward)', /500 suppressed/.test(tipSvg) && /12 fixed/.test(tipSvg) && /90 carried forward/.test(tipSvg) && /7 confirmed fixed/.test(tipSvg));
check('tooltip is hidden from screen readers (the dot already carries the label)', (tipSvg.match(/class="trend-tip" aria-hidden="true"/g)||[]).length === 2);
const rects = [...tipSvg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="(\d+)" height="(\d+)"/g)].map(m=>m.slice(1).map(Number));
check('tooltips stay inside the 640-wide chart, including at the right edge', rects.every(([x,,w])=>x>=0 && x+w<=640));
const overallTip = renderTrendChartSVG(agg.overall);
check('combined-line tooltip says how many sources it spans', /across 2 sources/.test(overallTip));

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
