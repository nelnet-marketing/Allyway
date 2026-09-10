// Phase 2 guard: the in-page ARC pull must group findings byte-identically to
// `node index.js`. Dispositions key off `fingerprint`, so any drift between the
// two paths silently orphans every triage decision on the next pull.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import assert from 'assert';
import { buildScanJson } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lift the browser-side implementation straight out of allyway.html and run it
// in a bare context — the pure grouping functions touch no DOM and no network.
function loadArcBuildScanJson() {
  const html = readFileSync(join(__dirname, '..', 'allyway.html'), 'utf8');
  const start = html.indexOf('/* ── ARC API pull (phase 2)');
  const end   = html.indexOf('/* One-time normalization of saved X-category');
  assert.ok(start > 0 && end > start, 'ARC pull block not found in allyway.html');
  const block = html.slice(start, end);
  // URL must be present: arcNormalizeUrl falls back to a raw lowercase on throw, so a
  // missing global would silently look like "normalization is broken" instead of erroring.
  const ctx = { window: {}, document: undefined, console, URL };
  vm.createContext(ctx);
  new vm.Script(block + '\n;({arcBuildScanJson, arcContrastSig});').runInContext(ctx);
  return new vm.Script('({arcBuildScanJson, arcContrastSig})').runInContext(ctx);
}

const { arcBuildScanJson, arcContrastSig } = loadArcBuildScanJson();

/* ── Fixtures: exercise every grouping branch ─────────────────────── */
const scanInfo = { date: '2026-03-14T18:22:05.000Z' };

// Standard rows: two rules, one spread over 20 pages so the 15-page HTML
// sampling cap and the 400-char slice both engage.
const rows = [];
for (let i = 1; i <= 20; i++) {
  rows.push({
    componentUrl: `https://WWW.Example.com/page-${i}/?utm=x#frag`,
    instanceHTMLSource: '<img src="a.png">' + 'x'.repeat(500),
    ruleKey: 'img-alt',
    ruleTitle: '  Images   must have <b>alternative</b> text  ',
    ruleSeverity: 'error',
    ruleDescription: 'Every &lt;img&gt; needs an alt attribute.&nbsp;See docs.',
  });
}
rows.push({
  componentUrl: 'https://example.com/page-1',
  instanceHTMLSource: '<a href="#"></a>',
  ruleKey: 'link-name',
  ruleTitle: 'Links must have discernible text',
  ruleSeverity: 'alert',
  ruleDescription: '',
});
rows.push({ componentUrl: '', instanceHTMLSource: '<i></i>', ruleKey: 'x', ruleTitle: '', ruleSeverity: '' });

// Contrast findings: digit-normalized classes, a role, a duplicate locator that
// must dedupe, and two categories so worseCat has to pick the worse one.
const contrast = [
  { componentUrl: 'https://example.com/a/', instanceLocator: '/html/body/div[1]', instanceLocatorType: 'xpath',
    instanceHTMLSource: '<span class="hero-2026 label b">Save</span>', ruleKey: 'color-contrast',
    severity: 'error', category: 'ALERT' },
  { componentUrl: 'https://example.com/a/', instanceLocator: '/html/body/div[1]', instanceLocatorType: 'xpath',
    instanceHTMLSource: '<span class="hero-2026 label b">Save</span>', ruleKey: 'color-contrast',
    severity: 'error', category: 'ERROR' },   // same locator → deduped away
  { componentUrl: 'https://example.com/b/', instanceLocator: '/html/body/div[2]', instanceLocatorType: 'xpath',
    instanceHTMLSource: '<span class="hero-1999 b label">Save</span>', ruleKey: 'color-contrast',
    severity: 'error', category: 'ERROR' },   // digits blanked + classes sorted → same signature as #1
  { componentUrl: 'https://example.com/c/', instanceLocator: '/html/body/nav', instanceLocatorType: 'xpath',
    instanceHTMLSource: '<div role="banner" class="top">Hi</div>', ruleKey: 'color-contrast-enhanced',
    severity: 'alert', category: 'BEST PRACTICE' },
];

/* ── Compare ──────────────────────────────────────────────────────── */
const expected = buildScanJson('Fixture', rows, contrast, scanInfo);
const actual   = arcBuildScanJson('Fixture', rows, contrast, scanInfo);

let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };

// generatedFrom is deliberately different — it records which path produced the scan.
check('generatedFrom marks the API path', actual.generatedFrom === 'arc-api' && expected.generatedFrom === 'index.js');
const strip = o => JSON.stringify({ ...o, generatedFrom: undefined });
check('whole scan.json matches index.js', strip(actual) === strip(expected));

check('scanDate normalized to YYYY-MM-DD', actual.scanDate === '2026-03-14');
check('standard fingerprints identical',
  JSON.stringify(actual.standard.map(d => d.fingerprint)) === JSON.stringify(expected.standard.map(d => d.fingerprint)));
check('contrast fingerprints identical',
  JSON.stringify(actual.contrast.map(d => d.fingerprint)) === JSON.stringify(expected.contrast.map(d => d.fingerprint)));

// Spot-check the branches the fixtures were built to hit.
const img = actual.standard.find(d => d.fingerprint === 'Images must have alternative text');
check('rule title collapsed + tags stripped for the fingerprint', !!img);
check('20 pages tracked', img && img.pages.length === 20);
check('HTML sampled for only the first 15 pages', img && img.pages.filter(p => p.html).length === 15);
check('sampled HTML capped at 400 chars', img && img.pages.every(p => p.html.length <= 400));
check('url normalized (www/query/hash stripped, lowercased)',
  img && img.pages.some(p => p.url === 'https://example.com/page-1'));
check('entities decoded in description', img && img.description === 'Every <img> needs an alt attribute. See docs.');
check('blank rule title dropped', actual.standard.length === 2);

check('contrast deduped by locator', actual.contrast.reduce((n, d) => n + d.instances, 0) === 3);
check('digit-blanked classes sort to one signature',
  arcContrastSig('<span class="hero-2026 label b">x</span>', 'color-contrast') ===
  arcContrastSig('<span class="hero-1999 b label">y</span>', 'color-contrast'));
const banner = actual.contrast.find(d => d.fingerprint.includes('[role=banner]'));
check('role captured in the signature', !!banner);
const hero = actual.contrast.find(d => d.fingerprint === 'color-contrast|span.b.hero-#.label');
check('worse category wins across grouped findings', hero && hero.category === 'ERROR');

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
