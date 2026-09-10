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

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
