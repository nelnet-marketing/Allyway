import fetch from 'node-fetch';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// Contrast SIGNATURE stability probe (READ-ONLY).
//
// The plan is to track contrast defects by an element "signature"
// (ruleKey + normalized element markup) rather than by rule. This only works if
// that signature is STABLE across scans. If a site uses build-hashed CSS classes,
// the signature churns every deploy and carry-forward breaks.
//
// This pulls N recent scans for one source, computes each contrast finding's
// signature exactly the way index.js does (normalizeContrastHtml), and reports
// how many signatures persist vs. churn across scans. Output is structural markup
// + counts only (element text stripped, numbers blanked) — no page content.
//
// Usage: node calibrate-contrast.mjs 'API_KEY' 'BenefitEd' [--scans=4] [--samples=12]
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.argv[2], SOURCE = process.argv[3];
const args = process.argv.slice(4);
const SCANS = (()=>{ const n=parseInt(args.find(a=>a.startsWith('--scans='))?.split('=')[1]??'',10); return Number.isFinite(n)&&n>=2?n:4; })();
const SAMPLES = (()=>{ const n=parseInt(args.find(a=>a.startsWith('--samples='))?.split('=')[1]??'',10); return Number.isFinite(n)&&n>=0?n:12; })();
if(!API_KEY||!SOURCE){ console.error("Usage: node calibrate-contrast.mjs 'API_KEY' 'Source Title' [--scans=4] [--samples=12]"); process.exit(1); }

const BASE='https://arc.tpgi.com/api';
const HEADERS={accept:'application/json','api-key':API_KEY};
const CONTRAST_CRITERIA=new Set(['1.4.3','1.4.11']);
const CAT_RANK={ERROR:0,ALERT:1,'BEST PRACTICE':2};
const REQUEST_TIMEOUT_MS=45000, MIN_PAGE_SIZE=10, MAX_SAME_SIZE_RETRIES=2;
const log=(...a)=>console.log('[con]',...a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ruleMap={};

async function loadRules(){ const res=await fetch(`${BASE}/v1/tests`,{headers:HEADERS});
  if(!res.ok) throw new Error(`Failed to load rules: ${res.status} ${res.statusText}`);
  for(const r of await res.json()) ruleMap[r.key]=r; log(`Rules loaded: ${Object.keys(ruleMap).length}`); }

async function resolveSourceId(title){ let offset=0; const all=[];
  while(true){ const res=await fetch(`${BASE}/v2/datasources?limit=500&offset=${offset}`,{headers:HEADERS});
    if(!res.ok) throw new Error(`datasources: ${res.status}`); const page=await res.json();
    if(!Array.isArray(page)||!page.length) break; all.push(...page); if(page.length<500) break; offset+=page.length; }
  const hit=all.find(s=>s.title===title);
  if(!hit){ console.error(`\nSource "${title}" not found. First 30:`); for(const s of all.slice(0,30)) console.error('  • '+s.title); process.exit(1); }
  return hit.id; }

async function getRecentScans(id,limit){ const res=await fetch(`${BASE}/v1/scans/${id}?status=success&limit=${limit}`,{headers:HEADERS});
  if(!res.ok) throw new Error(`scans: ${res.status}`); const d=await res.json(); return Array.isArray(d)?d:[]; }

function isTransient(e){ return e.code==='ERR_STREAM_PREMATURE_CLOSE'||e.name==='TimeoutError'||e.name==='AbortError'||e.code==='ECONNRESET'||e.code==='UND_ERR_SOCKET'; }
async function getScanFindings(scanId){ let offset=0,limit=100; const all=[];
  pages: while(true){ let data=null,tries=0;
    while(true){ try{ const res=await fetch(`${BASE}/v1/scans/${scanId}/findings?offset=${offset}&limit=${limit}`,{headers:HEADERS,signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
        if(!res.ok) throw new Error(`${res.status}`); data=await res.json(); break;
      }catch(err){ if(!isTransient(err)){ console.warn(`  stop at ${offset}: ${err.message}`); break pages; }
        if(tries<MAX_SAME_SIZE_RETRIES){ tries++; await sleep(500*tries); continue; }
        if(limit>MIN_PAGE_SIZE){ limit=Math.max(MIN_PAGE_SIZE,Math.floor(limit/2)); tries=0; continue; }
        console.warn(`  give up at ${offset}`); break pages; } }
    if(!Array.isArray(data)||!data.length) break; all.push(...data); if(data.length<limit) break; offset+=data.length; }
  return all; }

const isContrast=f=>{ const r=ruleMap[f.ruleKey]; return r?.standards?.some(s=>CONTRAST_CRITERIA.has(s.criterionKey))??false; };
function normUrl(raw){ try{ const u=new URL(raw); u.hostname=u.hostname.replace(/^www\./,''); u.pathname=u.pathname.replace(/\/+$/,'')||'/'; u.search=''; u.hash=''; return u.toString().toLowerCase(); }catch{ return String(raw||'').toLowerCase().replace(/\/+$/,''); } }
function normalizeContrastHtml(html){ return (html||'').replace(/>\s*[^<>]*\s*</g,'><').replace(/\d+/g,'#').replace(/\s+/g,' ').trim(); }
function isoDate(s){ const d=new Date(s); if(isNaN(d)) return ''; return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

// COARSE signature: ruleKey + tag + sorted class list + role only. Drops href/id/style/
// title/data-* etc. (the instance-specific, churn-prone bits), keeps the styled-element
// identity that makes "same pattern across N pages = one defect" work. Numbers → #.
function coarseSig(html,ruleKey){
  const h=html||'';
  const tag=(h.match(/^\s*<\s*([a-zA-Z][\w-]*)/)||[])[1]||'?';
  const cls=(h.match(/class\s*=\s*"([^"]*)"/i)||[])[1]||'';
  const role=(h.match(/role\s*=\s*"([^"]*)"/i)||[])[1]||'';
  const classes=cls.replace(/\d+/g,'#').split(/\s+/).filter(Boolean).sort().join('.');
  return `${ruleKey}|${tag}${classes?'.'+classes:''}${role?'[role='+role+']':''}`;
}

// Reduce one scan to its set of coarse contrast signatures (deduped by locator, like index.js).
function contrastSignatures(findings){
  const seen=new Set(), sigs=new Map();
  for(const f of findings){ if(!isContrast(f)) continue;
    const url=normUrl(f.componentUrl??'');
    const dedupe=`${url}|||${f.instanceLocatorType}|||${f.instanceLocator}|||${f.ruleKey}`;
    if(seen.has(dedupe)) continue; seen.add(dedupe);
    const key=coarseSig(f.instanceHTMLSource,f.ruleKey);
    let g=sigs.get(key); if(!g){ g={key,ruleKey:f.ruleKey,example:normalizeContrastHtml(f.instanceHTMLSource).slice(0,120),instances:0,urls:new Set(),cats:new Set()}; sigs.set(key,g); }
    g.instances++; g.urls.add(url); const c=catOf(f); if(c) g.cats.add(c); }
  return sigs;
}

// Element-only signature (tag + class + role, NO ruleKey) — used to detect Error↔Alert flips.
function elementKey(html){ const h=html||'';
  const tag=(h.match(/^\s*<\s*([a-zA-Z][\w-]*)/)||[])[1]||'?';
  const cls=(h.match(/class\s*=\s*"([^"]*)"/i)||[])[1]||'';
  const role=(h.match(/role\s*=\s*"([^"]*)"/i)||[])[1]||'';
  const classes=cls.replace(/\d+/g,'#').split(/\s+/).filter(Boolean).sort().join('.');
  return `${tag}${classes?'.'+classes:''}${role?'[role='+role+']':''}`; }
function catOf(f){ return f.category || ruleMap[f.ruleKey]?.type?.title || ''; }
function scanElements(findings){ const seen=new Set(), els=new Map();
  for(const f of findings){ if(!isContrast(f)) continue; const url=normUrl(f.componentUrl??'');
    const dedupe=`${url}|||${f.instanceLocatorType}|||${f.instanceLocator}|||${f.ruleKey}`; if(seen.has(dedupe)) continue; seen.add(dedupe);
    const k=elementKey(f.instanceHTMLSource); let g=els.get(k); if(!g){ g={key:k,urls:new Set(),cats:new Set()}; els.set(k,g); }
    g.urls.add(url); const c=catOf(f); if(c) g.cats.add(c); }
  return els; }
function worstCat(set){ let w=null,wr=9; for(const c of set){ const r=CAT_RANK[(c||'').toUpperCase()]??9; if(r<wr){wr=r;w=c;} } return w; }

// Jaccard overlap of signature SETS across scans, keeping only sigs on >= minPages pages.
function overlap(scanSigs,minPages){
  const chrono=[...scanSigs].sort((a,b)=>a.date.localeCompare(b.date));
  const keyset=s=>new Set([...s.sigs.values()].filter(g=>g.urls.size>=minPages).map(g=>g.key));
  const rows=[]; let prev=null;
  for(const s of chrono){ const cur=keyset(s);
    if(!prev){ rows.push({date:s.date,sigs:cur.size,shared:null,added:null,dropped:null,jaccard:null}); prev=cur; continue; }
    let shared=0; for(const k of cur) if(prev.has(k)) shared++; const union=cur.size+prev.size-shared;
    rows.push({date:s.date,sigs:cur.size,shared,added:cur.size-shared,dropped:prev.size-shared,jaccard:union?+(shared/union).toFixed(2):null}); prev=cur; }
  return rows;
}
function avgJ(rows){ const j=rows.filter(r=>r.jaccard!=null); return j.length?j.reduce((a,r)=>a+r.jaccard,0)/j.length:0; }
function printOverlap(title,rows){ console.log(`\n${title}`); console.log('date        sigs  shared  added  dropped  overlap');
  for(const r of rows){ const p=(v,w)=>String(v??'—').padStart(w); console.log(`${r.date}  ${p(r.sigs,4)}  ${p(r.shared,6)}  ${p(r.added,5)}  ${p(r.dropped,7)}  ${r.jaccard??'—'}`); } }

async function run(){
  await loadRules();
  const id=await resolveSourceId(SOURCE); log(`Source "${SOURCE}" → ${id}`);
  const scanList=await getRecentScans(id,SCANS);
  if(scanList.length<2){ console.error('Need ≥2 scans.'); process.exit(1); }
  log(`Pulling contrast findings for ${scanList.length} scan(s)…`);
  const scanSigs=[], scanEls=[], scansOut=[];
  for(const s of scanList){ process.stdout.write(`  scan ${s.scanId} (${isoDate(s.date)})… `);
    const raw=await getScanFindings(s.scanId); const sigs=contrastSignatures(raw);
    const total=[...sigs.values()].reduce((n,g)=>n+g.instances,0);
    const multiN=[...sigs.values()].filter(g=>g.urls.size>=2).length;
    console.log(`${sigs.size} coarse sigs (${multiN} on ≥2 pages), ${total} contrast instances`);
    scanSigs.push({date:isoDate(s.date),sigs});
    scanEls.push({date:isoDate(s.date),sigs:scanElements(raw)});
    const catInst={},catSig={},catSigMulti={};
    for(const g of sigs.values()){ const w=worstCat(g.cats)||'—'; catSig[w]=(catSig[w]||0)+1; catInst[w]=(catInst[w]||0)+g.instances; if(g.urls.size>=2) catSigMulti[w]=(catSigMulti[w]||0)+1; }
    scansOut.push({scanId:s.scanId,date:isoDate(s.date),distinctSignatures:sigs.size,multiPageSignatures:multiN,contrastInstances:total,
      categoryBreakdown:{instances:catInst,signatures:catSig,multiPageSignatures:catSigMulti},
      topSignatures:[...sigs.values()].sort((a,b)=>b.urls.size-a.urls.size).slice(0,SAMPLES).map(g=>({key:g.key,category:worstCat(g.cats)||'',example:g.example,instances:g.instances,pages:g.urls.size}))}); }

  const all=overlap(scanSigs,1), multi=overlap(scanSigs,2);
  const elMulti=overlap(scanEls,2);
  // Category FLIP: per element, worst category per scan; flip if >1 distinct category across scans.
  const catByEl=new Map();
  for(const s of scanEls){ for(const g of s.sigs.values()){ const w=worstCat(g.cats); if(!w) continue;
    if(!catByEl.has(g.key)) catByEl.set(g.key,new Set()); catByEl.get(g.key).add(w); } }
  const multiEls=new Set(); for(const s of scanEls) for(const g of s.sigs.values()) if(g.urls.size>=2) multiEls.add(g.key);
  let flippers=0, multiFlippers=0; const flipExamples=[];
  for(const [k,cats] of catByEl){ if(cats.size>1){ flippers++; if(multiEls.has(k)){ multiFlippers++; if(flipExamples.length<10) flipExamples.push({el:k,cats:[...cats]}); } } }
  const chrono=[...scanSigs].sort((a,b)=>a.date.localeCompare(b.date));
  const multiKeys=new Set(); chrono.forEach(s=>s.sigs.forEach((g,k)=>{ if(g.urls.size>=2) multiKeys.add(k); }));
  let inAllMulti=0; for(const k of multiKeys){ if(chrono.every(s=>{ const g=s.sigs.get(k); return g&&g.urls.size>=2; })) inAllMulti++; }
  const allKeys=new Set(); chrono.forEach(s=>s.sigs.forEach((g,k)=>allKeys.add(k)));

  const out={source:SOURCE,scanCount:scansOut.length,signatureScheme:'coarse (ruleKey + tag + sorted class + role)',
    note:'example markup normalized (text stripped, numbers→#); structural only',
    overlapAll:all,overlapMultiPage:multi,elementOnlyOverlapMultiPage:elMulti,
    categoryFlips:{total:flippers,multiPage:multiFlippers,examples:flipExamples},
    distinctSignaturesAcrossAll:allKeys.size,multiPageSignaturesPresentInAll:inAllMulti,scans:scansOut};
  const folder=join(__dirname,'calibration'); mkdirSync(folder,{recursive:true});
  const path=join(folder,`${SOURCE.replace(/[:\\/?*[\]]/g,' ').trim()} - contrast-signatures.json`);
  writeFileSync(path,JSON.stringify(out,null,2));

  printOverlap('──── ALL coarse signatures ────',all);
  printOverlap('──── MULTI-PAGE only (≥2 pages) — the trackable subset ────',multi);
  const aAll=avgJ(all), aMulti=avgJ(multi);
  console.log(`\nDistinct signatures across all scans: ${allKeys.size}  |  multi-page present in ALL: ${inAllMulti}`);
  console.log(`Avg overlap — all sigs: ${aAll.toFixed(2)}  |  multi-page (≥2): ${aMulti.toFixed(2)}`);
  console.log(aMulti>=0.7 ? '→ Multi-page contrast signatures are STABLE — coarse-signature tracking is viable (treat 1-page ones as noise, like standard rules).'
                          : '→ Multi-page still churns — fall back to per-page contrast keying.');
  printOverlap('──── ELEMENT-ONLY signatures (no ruleKey), multi-page ────',elMulti);
  console.log(`\nCategory FLIP (same element rated Error in one scan, Alert in another): ${flippers} elements total, ${multiFlippers} on ≥2 pages`);
  if(flipExamples.length){ console.log('Multi-page flippers:'); for(const f of flipExamples) console.log(`  ${f.cats.join(' ↔ ')}   ${f.el}`); }
  console.log(multiFlippers>0
    ? '→ ARC flips Error/Alert on multi-page elements HERE — dropping ruleKey from the contrast signature protects carry-forward across the flip.'
    : '→ No multi-page category flips on this site — ruleKey is harmless here (but BE showed it flips on image-heavy sites).');
  const latest=scansOut[0];
  if(latest&&latest.categoryBreakdown){ const b=latest.categoryBreakdown;
    const fmt=o=>Object.entries(o).map(([k,v])=>`${v} ${k}`).join(' · ')||'none';
    console.log(`\nManual-check burden (latest scan ${latest.date}):`);
    console.log(`  contrast instances by category:      ${fmt(b.instances)}`);
    console.log(`  multi-page signatures by category:   ${fmt(b.multiPageSignatures)}   (Alert = go eyeball; Error = just fix)`);
  }
  console.log('');
  log(`✅ Wrote: ${path}`);
  log('Send me that JSON — coarse signatures + counts + example markup, no page content.');
}
run().catch(e=>{ console.error('❌',e); process.exit(1); });
