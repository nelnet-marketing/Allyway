// Tests for the triage backup export in ../allyway.html.
// Extracts the real collectTriage() and checks it captures what the work list drops.
// Run: node tests/export.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

const html = readFileSync(join(here, '..', 'allyway.html'), 'utf8');
const from = html.indexOf('function collectTriage()');
const to = html.indexOf('function exportTriage()');
if (from < 0 || to < from) { console.log('FAIL could not extract collectTriage from allyway.html'); process.exit(1); }
const collectTriage = new Function('state', html.slice(from, to) + '; return collectTriage();');

/* A source shaped like the real data: the bulk of the work is in statuses the work list
   ignores, one disposition carries only a note, and a manual finding is still untriaged. */
const state = {
  source: 'Propelr',
  xcats: ['YouTube Video Player', 'ReCaptcha'],
  dispositions: {
    'Heading level skipped|||https://gopropelr.com/': { status: 'fixed', notes: 'footer headings to h2' },
    'textWithBackgroundImage|a.nav-link': { status: 'not_issue', notes: '#1a3361 vs #FFF = 12.4:1' },
    'aria-hidden used': { status: 'ok_ignore', reason: 'Best Practice' },
    'Duplicate labels used': { status: 'cant_fix', xcat: 'ReCaptcha' },
    'Missing href': { status: 'need_fix', globalFix: true, assignee: 'Jose', fix: '## Fix\n\nUse a real `href`.' },
    'No label for button element|||https://gopropelr.com/products': { notes: 'no status, just a note' },
  },
  manualFindings: [
    { id: 'm_1', title: 'Testimonials', status: 'need_fix', assignee: 'Jose', note: 'update component', type: 'a11y', severity: 'MEDIUM' },
    { id: 'm_2', title: 'test', status: 'untriaged', note: '', type: 'a11y', severity: 'MEDIUM' },
  ],
};

const rows = collectTriage(state);
const disp = rows.filter(r => r.kind === 'disp');
const manual = rows.filter(r => r.kind === 'manual');
const config = rows.filter(r => r.kind === 'config');

eq('every disposition is exported, whatever its status', disp.length, 6);
eq('manual findings included even when untriaged', manual.length, 2);
eq('xcats captured as one config row', config.length, 1);
eq('xcats list is readable', config[0].notes, 'YouTube Video Player | ReCaptcha');

// the whole point: the work list only covers 4 statuses, so it would drop most of this
const WORKLIST = new Set(['need_fix', 'in_progress', 'needs_approval', 'deferred']);
eq('work list would have captured only 1 of these 6 decisions',
  disp.filter(r => WORKLIST.has(r.status)).length, 1);

// dkey is what a restore writes back to — it must survive verbatim, prefix and all
eq('contrast signature keeps its prefix',
  disp.some(r => r.dkey === 'textWithBackgroundImage|a.nav-link'), true);
eq('page-scoped dkey keeps its ||| separator',
  disp.some(r => r.dkey === 'Heading level skipped|||https://gopropelr.com/'), true);
eq('manual finding carries its mid as the key', manual.map(r => r.dkey).sort(), ['m_1', 'm_2']);
eq('no row is missing its key', rows.filter(r => !r.dkey).length, 0);
eq('every row is stamped with a source', rows.filter(r => !r.source).length, 0);

// the prose is the part that would hurt to redo
const noted = rows.filter(r => (r.notes || '').trim()).length;
eq('notes carried through (incl. the status-less one)', noted, 5);
eq('multi-line fix instructions survive intact',
  disp.find(r => r.dkey === 'Missing href').fix, '## Fix\n\nUse a real `href`.');
eq('globalFix flagged readably', disp.find(r => r.dkey === 'Missing href').globalFix, 'yes');
eq('reason carried through', disp.find(r => r.dkey === 'aria-hidden used').reason, 'Best Practice');
eq('xcat carried through', disp.find(r => r.dkey === 'Duplicate labels used').xcat, 'ReCaptcha');

// untriaged findings have no disposition row at all, so nothing to exclude
eq('no empty-status disp row invented for untriaged items',
  disp.every(r => 'status' in r), true);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
