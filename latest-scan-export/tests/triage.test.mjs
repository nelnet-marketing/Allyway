// Unit + round-trip tests for the Triage Report logic in ../index.js
// Run: node tests/triage.test.mjs
import ExcelJS from 'exceljs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeText, isoDateFromScan, buildTriageGroups, addTriageSheet, tagSuffix } from '../index.js';

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

// --- sanitizeText: strip tags first, then decode entities ---
eq('sanitize strips <code>', sanitizeText('Bad ARIA <code>role</code>'), 'Bad ARIA role');
eq('sanitize decodes entities after strip', sanitizeText('&lt;ul&gt; and &lt;ol&gt; must only'), '<ul> and <ol> must only');
eq('sanitize nested tag+entity', sanitizeText('The <code>&lt;label&gt;</code> associated'), 'The <label> associated');
eq('sanitize amp last', sanitizeText('A &amp; B'), 'A & B');
eq('sanitize empty', sanitizeText(''), '');

// --- tagSuffix (filename suffix from opt-in flags) ---
eq('tagSuffix none (unchanged default)', tagSuffix(false, false), '');
eq('tagSuffix detail only', tagSuffix(true, false), ' - detailed');
eq('tagSuffix triage only', tagSuffix(false, true), ' - triage');
eq('tagSuffix both', tagSuffix(true, true), ' - detailed-triage');

// --- isoDateFromScan (UTC-of-local-parse, matches ARC filename behavior) ---
eq('isoDate matches filename behavior', isoDateFromScan('2026-05-20T23:38:11.6866667'), '2026-05-21');

// --- buildTriageGroups ---
const row = (o) => ({
  componentTitle: o.title, componentUrl: o.url, instanceEngineKey: o.engine,
  ruleKey: o.ruleKey, ruleTitle: o.ruleTitle, ruleSeverity: o.sev, ruleCategory: o.cat,
  ruleDescription: o.desc || '', instanceHTMLSource: o.html || ''
});

const rows = [];
// CRITICAL / Alert — 2 pages, 3 instances
rows.push(row({ ruleKey:'buttons', ruleTitle:'Buttons must have discernible text', sev:'CRITICAL', cat:'Alert', engine:'AXE', title:'Cyber', url:'https://x.com/post/cyberse', html:'<button>a</button>' }));
rows.push(row({ ruleKey:'buttons', ruleTitle:'Buttons must have discernible text', sev:'CRITICAL', cat:'Alert', engine:'AXE', title:'Cyber', url:'https://x.com/post/cyberse', html:'<button>b</button>' }));
rows.push(row({ ruleKey:'buttons', ruleTitle:'Buttons must have discernible text', sev:'CRITICAL', cat:'Alert', engine:'AXE', title:'P2PE', url:'https://x.com/post/p2pe', html:'<button>c</button>' }));
// HIGH / Error — 2 pages, 4 instances
for (let i=0;i<3;i++) rows.push(row({ ruleKey:'badaria', ruleTitle:'Bad ARIA <code>role</code>', sev:'HIGH', cat:'Error', engine:'ARC', title:'Cyber', url:'https://x.com/post/cyberse', desc:'The element uses an invalid ARIA <code>role</code>', html:'<span>x</span>' }));
rows.push(row({ ruleKey:'badaria', ruleTitle:'Bad ARIA <code>role</code>', sev:'HIGH', cat:'Error', engine:'ARC', title:'From', url:'https://x.com/post/from', desc:'The element uses an invalid ARIA <code>role</code>', html:'<span>y</span>' }));
// HIGH / Best Practice — 1 page, 40 instances (must sort AFTER Error despite higher count)
for (let i=0;i<40;i++) rows.push(row({ ruleKey:'ariablby', ruleTitle:'aria-labelledby on incompatible element', sev:'HIGH', cat:'Best Practice', engine:'ARC', title:'Contact', url:'https://x.com/contact-us', html:'<span>z</span>' }));

const perSourceRowsMap = new Map([['SiteA', rows]]);
const scanInfoMap = new Map([['SiteA', { date:'2026-05-20T23:38:11.6866667' }]]);
const groups = buildTriageGroups(perSourceRowsMap, scanInfoMap);

eq('sort order (sev then category)', groups.map(g=>g.ruleTitle),
  ['Buttons must have discernible text', 'Bad ARIA role', 'aria-labelledby on incompatible element']);

const buttons = groups[0];
eq('buttons total instances', buttons.totalInstances, 3);
eq('buttons pages', buttons.pages, 2);
eq('buttons children sorted by url', buttons.children.map(c=>c.url), ['https://x.com/post/cyberse','https://x.com/post/p2pe']);
eq('buttons child cyberse instances', buttons.children[0].instances, 2);
eq('buttons child html (first seen)', buttons.children[0].html, '<button>a</button>');

const badaria = groups[1];
eq('badaria title sanitized', badaria.ruleTitle, 'Bad ARIA role');
eq('badaria desc sanitized', badaria.description, 'The element uses an invalid ARIA role');
eq('badaria total', badaria.totalInstances, 4);
eq('badaria firstSeen', badaria.firstSeen, '2026-05-21');

// --- addTriageSheet: real writer, round-trip through xlsx to confirm outline ---
const wb = new ExcelJS.Workbook();
addTriageSheet(wb, perSourceRowsMap, scanInfoMap);
const out = join(tmpdir(), 'arc-triage-test-out.xlsx');
await wb.xlsx.writeFile(out);

const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.readFile(out);
const sh = wb2.getWorksheet('Triage Report');
eq('sheet exists', !!sh, true);
eq('outlineLevelRow persisted', sh.properties.outlineLevelRow, 1);
eq('summaryBelow=false persisted', sh.properties.outlineProperties?.summaryBelow, false);

const header = [];
sh.getRow(1).eachCell(c => header.push(c.value));
eq('headers', header, ['Rule Title','Severity','Category','Engine','Status / Components','HTML Source Code','Ignored (mark Yes)','Pages / Instances','Total Instances','Description','First Seen','Last Seen','Trend']);

eq('r2 parent ol', sh.getRow(2).outlineLevel || 0, 0);
eq('r2 trend', sh.getRow(2).getCell(13).value, '2026-05-21: 3');
eq('r3 child ol', sh.getRow(3).outlineLevel, 1);
eq('r3 child hidden', !!sh.getRow(3).hidden, true);
eq('r3 child rule col = url with arrow', sh.getRow(3).getCell(1).value, '  ↳ https://x.com/post/cyberse');
eq('r3 child status/components = title', sh.getRow(3).getCell(5).value, 'Cyber');
eq('r3 child pages/instances = 2', sh.getRow(3).getCell(8).value, 2);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
