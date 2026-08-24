// Unit + round-trip tests for the Findings Summary outline in ../index.js
// Run: node tests/findings-summary.test.mjs
import ExcelJS from 'exceljs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFindingsSummaryRows, buildFindingsSummaryGroups, addFindingsSummarySheet } from '../index.js';

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

const row = (o) => ({
  componentTitle: o.title, componentUrl: o.url, instanceEngineKey: o.engine,
  ruleKey: o.ruleKey, ruleTitle: o.ruleTitle, ruleSeverity: o.sev, ruleCategory: o.cat,
  ruleDescription: o.desc || '', ruleComplementary: o.comp || ''
});

const rows = [];
// Cyber page: 2 rules — buttons (2 instances) + badaria (1 instance) = 3 total
rows.push(row({ ruleKey:'buttons', ruleTitle:'Buttons must have discernible text', sev:'CRITICAL', cat:'Alert', engine:'AXE', title:'Cyber', url:'https://x.com/post/cyberse' }));
rows.push(row({ ruleKey:'buttons', ruleTitle:'Buttons must have discernible text', sev:'CRITICAL', cat:'Alert', engine:'AXE', title:'Cyber', url:'https://x.com/post/cyberse' }));
rows.push(row({ ruleKey:'badaria', ruleTitle:'Bad ARIA role', sev:'HIGH', cat:'Error', engine:'ARC', title:'Cyber', url:'https://x.com/post/cyberse' }));
// P2PE page: 1 rule — buttons (1 instance)
rows.push(row({ ruleKey:'buttons', ruleTitle:'Buttons must have discernible text', sev:'CRITICAL', cat:'Alert', engine:'AXE', title:'P2PE', url:'https://x.com/post/p2pe' }));

const perSourceRowsMap = new Map([['SiteA', rows]]);

// --- buildFindingsSummaryGroups: one group per component/URL, subtotal = sum of children ---
const summaryRows = buildFindingsSummaryRows(perSourceRowsMap);
const groups = buildFindingsSummaryGroups(summaryRows);

eq('group count (2 distinct URLs)', groups.length, 2);
eq('groups ordered by url', groups.map(g => g.componentUrl), ['https://x.com/post/cyberse', 'https://x.com/post/p2pe']);

const cyber = groups[0];
eq('cyber subtotal = sum of children', cyber.instances, cyber.children.reduce((s, c) => s + c.instances, 0));
eq('cyber subtotal value', cyber.instances, 3);
eq('cyber has 2 rule children', cyber.children.length, 2);
eq('cyber component title', cyber.componentTitle, 'Cyber');

const p2pe = groups[1];
eq('p2pe subtotal', p2pe.instances, 1);
eq('p2pe has 1 rule child', p2pe.children.length, 1);

// --- addFindingsSummarySheet: real writer, round-trip through xlsx to confirm outline ---
const wb = new ExcelJS.Workbook();
addFindingsSummarySheet(wb, perSourceRowsMap);
const out = join(tmpdir(), 'arc-findings-summary-test-out.xlsx');
await wb.xlsx.writeFile(out);

const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.readFile(out);
const sh = wb2.getWorksheet('Findings Summary');
eq('sheet exists', !!sh, true);
eq('outlineLevelRow persisted', sh.properties.outlineLevelRow, 1);
eq('summaryBelow=false persisted', sh.properties.outlineProperties?.summaryBelow, false);

const header = [];
sh.getRow(1).eachCell(c => header.push(c.value));
eq('headers', header, ['Component','URL','Engine','Rule Title','Severity','Category','Instances','Description','Complementary']);

// Layout: r1 header, r2 parent (Cyber), r3+r4 children, r5 parent (P2PE), r6 child, r7 TOTAL
eq('r2 parent outline level 0', sh.getRow(2).outlineLevel || 0, 0);
eq('r2 parent component', sh.getRow(2).getCell(1).value, 'Cyber');
eq('r2 parent url', sh.getRow(2).getCell(2).value, 'https://x.com/post/cyberse');
eq('r2 parent subtotal instances', sh.getRow(2).getCell(7).value, 3);

eq('r3 child outline level 1', sh.getRow(3).outlineLevel, 1);
eq('r3 child hidden (collapsed)', !!sh.getRow(3).hidden, true);
eq('r3 child component blank', sh.getRow(3).getCell(1).value ?? null, null);
eq('r3 child has rule title', sh.getRow(3).getCell(4).value, 'Buttons must have discernible text');

eq('r5 second parent url', sh.getRow(5).getCell(2).value, 'https://x.com/post/p2pe');
eq('r5 second parent level 0', sh.getRow(5).outlineLevel || 0, 0);

// Grand total = sum of all instances, on the last row
const lastRow = sh.lastRow;
eq('total label', lastRow.getCell(1).value, 'TOTAL');
eq('total = sum of all instances', lastRow.getCell(7).value, 4);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
