// Triage-backup restore — parseCSV must correctly round-trip exactly what downloadRows'
// local-preview CSV writer (and the Rideshare downloadCSV platform helper, same escaping
// rules) produces: a BOM, quoted fields with embedded commas/quotes/newlines.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadParseCSV() {
  const html = readFileSync(join(__dirname, '..', 'allyway.html'), 'utf8');
  const start = html.indexOf('function parseCSV(text){');
  const end = html.indexOf('/* Restore a "<source>', start);
  assert.ok(start > 0 && end > start, 'parseCSV not found');
  const ctx = { console };
  vm.createContext(ctx);
  new vm.Script(html.slice(start, end) + '\n;({parseCSV});').runInContext(ctx);
  return new vm.Script('({parseCSV})').runInContext(ctx);
}
const { parseCSV } = loadParseCSV();

// The exact escaping rule downloadRows' local-preview writer uses (and downloadCSV documents
// as the same behavior): wrap in quotes and double any embedded quote if the value contains
// a comma, quote, or newline.
const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCSV(rows, keys) {
  return '﻿' + keys.join(',') + '\n' + rows.map(r => keys.map(k => cell(r[k])).join(',')).join('\n');
}

let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };

/* ── Round-trip a realistic exportTriage()-shaped file ─────────────────────── */
const keys = ['kind','source','dkey','status','reason','xcat','assignee','globalFix','notes','fix'];
const rows = [
  { kind:'disp', source:'Propelr', dkey:'Link, target not focusable', status:'ok_ignore', reason:'Best Practice', xcat:'', assignee:'', globalFix:'', notes:'', fix:'' },
  { kind:'disp', source:'Propelr', dkey:'Uses "aria-hidden"', status:'need_fix', reason:'', xcat:'', assignee:'Jose', globalFix:'yes', notes:'flagged for Q4', fix:'Add tabindex="-1" to the wrapper,\nthen retest with a screen reader.' },
];
const csvText = toCSV(rows, keys);
const parsed = parseCSV(csvText);

check('parses the right number of rows', parsed.length === 2);
check('a comma inside a quoted field survives intact', parsed[0].dkey === 'Link, target not focusable');
check('a doubled quote inside a quoted field decodes to one quote', parsed[1].dkey === 'Uses "aria-hidden"');
check('an embedded newline inside a quoted field does not split the row', parsed[1].fix.includes('\n') && parsed.length === 2);
check('multi-line field content is preserved verbatim', parsed[1].fix === 'Add tabindex="-1" to the wrapper,\nthen retest with a screen reader.');
check('a plain unquoted field round-trips as-is', parsed[0].status === 'ok_ignore');
check('globalFix "yes" marker survives', parsed[1].globalFix === 'yes');
check('an empty field round-trips as an empty string, not undefined', parsed[0].xcat === '');
check('BOM at the start of the file does not leak into the first header name', Object.keys(parsed[0])[0] === 'kind');

/* ── Edge cases ─────────────────────────────────────────────────────────── */
check('a header-only file (no data rows) parses to an empty array', parseCSV('﻿kind,source,dkey\n').length === 0);
check('an empty string parses to an empty array without throwing', parseCSV('').length === 0);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
