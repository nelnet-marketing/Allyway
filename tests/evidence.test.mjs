// Evidence on manual findings: the backup zip must round-trip (stored and deflated), and the
// collectTriage evidence column must carry what a restore needs.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deflateRawSync } from 'zlib';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'allyway.html'), 'utf8').replace(/\r\n/g, '\n');

const from = html.indexOf('/* ── ZIP for the triage backup');
const to = html.indexOf('const zipSafeName=');
assert.ok(from > 0 && to > from, 'zip helpers not found');
const zip = new Function('Blob', 'TextEncoder', 'TextDecoder', 'Response', 'DecompressionStream',
  html.slice(from, to) + '; return {crc32, zipBuild, zipRead};')(Blob, TextEncoder, TextDecoder, Response, DecompressionStream);

let fails = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };
const bytes = s => new TextEncoder().encode(s);

// known CRC-32 of "123456789"
check('crc32 matches the standard check value', zip.crc32(bytes('123456789')) === 0xCBF43926);

// store-only round trip, including non-ASCII names and binary data
const png = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31 + 7) & 255);
const blob = zip.zipBuild([
  { name: 'triage backup.csv', data: bytes('kind,source\nmanual,Propelr\n') },
  { name: 'evidence/001-café screenshot.png', data: png },
  { name: 'evidence/002-empty.webm', data: new Uint8Array(0) },
]);
const back = await zip.zipRead(await blob.arrayBuffer());
check('three entries come back', back.length === 3);
check('names survive, including UTF-8', back[1].name === 'evidence/001-café screenshot.png');
check('csv text survives', new TextDecoder().decode(back[0].data) === 'kind,source\nmanual,Propelr\n');
check('binary data survives byte for byte', Buffer.compare(Buffer.from(back[1].data), Buffer.from(png)) === 0);
check('an empty file survives', back[2].data.length === 0);

// a deflated entry, as a re-zipped backup would hold
function deflatedZip(name, data) {
  const nm = Buffer.from(name), comp = deflateRawSync(Buffer.from(data));
  const crc = zip.crc32(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(0, 42);
  const cd = Buffer.concat([ch, nm]), body = Buffer.concat([lh, nm, comp]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  const all = Buffer.concat([body, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}
const text = 'triage,backup\n'.repeat(500);
const d = await zip.zipRead(deflatedZip('triage backup.csv', bytes(text)));
check('a deflated entry is inflated', d.length === 1 && new TextDecoder().decode(d[0].data) === text);

let threw = false;
try { await zip.zipRead(bytes('not a zip at all').buffer); } catch { threw = true; }
check('a non-zip is rejected', threw);

// collectTriage adds the evidence column only when asked
const exportSrc = readFileSync(join(__dirname, 'export.test.mjs'), 'utf8');
check('export.test.mjs still slices collectTriage up to exportTriage', exportSrc.includes("indexOf('function exportTriage()')"));
check('collectTriage takes the evidence paths', /function collectTriage\(evPaths\)/.test(html));
check('the evidence column carries id, alt and the zip path', /evidence:JSON\.stringify\(m\.evidence\.map\(e=>\(\{\.\.\.e, file:evPaths\[e\.id\]\|\|''\}\)\)\)/.test(html));

if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log('\nall evidence tests passed');
