---
name: pull-scan
description: Run the ARC scan script (node index.js) for one or more Allyway sources, optionally for a past month, and check the scan.json files it writes so they're ready for "Load scan.json" in Allyway. Use for sources too big for the in-page "Pull latest scan" (Nelnet.com), when the ARC connection in Rideshare is unavailable, or when Teisha says "pull Nelnet.com", "pull Nelnet.com for August", "run the scan script", "get fresh scans for X, Y", or "pull-scan".
---

# Pull ARC scans with the script

`index.js` talks to ARC directly, so it has no daily call cap and no 10-second broker limit. ARC is
reachable with the VPN **on** (checked 2026-10-21), so there is normally no need to disconnect. Do
every source in **one** run, then load them all in **one** step.

## Arguments

`/pull-scan <Source>[, <Source>…] [<month> …]`

- **Sources** are ARC titles, exactly (e.g. `Nelnet.com`). Several sources: comma-separate them.
- **No month** → the most recent completed scan (the default).
- **Month** → the most recent completed scan *within that calendar month*. Accept `2026-08`,
  `Aug 2026` or `August 2026`. A bare month name (`August`) means the most recent such month that
  isn't in the future; say which year you picked and let Teisha correct it.
- **Several months** (`2026-07 2026-08`) → one run per month, per source.

Examples: `/pull-scan Nelnet.com`, `/pull-scan Nelnet.com 2026-08`, `/pull-scan Propelr, Bloomwell July`.
With no source, ask which.

## Step 1 — Confirm the setup (don't skip)

- **Can ARC be reached?** Use `--ssl-no-revoke` (plain Windows curl fails the certificate-revocation check and prints a misleading `000`): `curl --ssl-no-revoke -s -o /dev/null -w "%{http_code}" --max-time 10 https://arc.vispero.com/api/v1/tests`. Any HTTP code (401 is expected without a key) means it's reachable. Only if it times out or fails DNS should you suggest disconnecting the VPN, and say it's a last resort.
- **API key** is read from `~/.claude/arc-api-key` (a plain file in Teisha's home folder, outside any repo, so it can't be committed). Check it exists without printing it: `[ -s "$HOME/.claude/arc-api-key" ] && echo found || echo missing`. If it's missing, ask Teisha to put the ARC key in that file (or give it to you in chat so you can write it there); never echo the key back, never put it in the repo or in this skill file. If ARC returns 401, the key was rotated: ask for the new one and overwrite that file.
- Source names must match ARC's titles exactly. A title that doesn't resolve prints `Source not found` and is skipped.

## Step 2 — Run the script

From the repo root (`C:\neldevsrc\ARC\Allyway`).

**Latest scan** — sources comma-separated in ONE argument:

```bash
node index.js "$(cat "$HOME/.claude/arc-api-key")" "Nelnet.com, Bloomwell, Propelr"
```

**A month** — turn the month into `--date-from` (first day) and `--date-to` (last day, inclusive), e.g.
August 2026:

```bash
node index.js "$(cat "$HOME/.claude/arc-api-key")" "Nelnet.com" --date-from=2026-08-01 --date-to=2026-08-31
```

Compute the last day with `node -e "const[y,m]=process.argv[1].split('-').map(Number);console.log(new Date(Date.UTC(y,m,0)).toISOString().slice(0,10))" 2026-08`.
If a source has no completed scan in that month the script logs `No completed scan found … in the
specified date range` and writes nothing for it: tell Teisha, and offer the nearest months.

**The script always writes to the same path**, `ARC Reports/<Source>/<Source> - scan.json`, so a later
run overwrites an earlier one. After **each** run, copy the file before the next run:

```bash
cp "ARC Reports/Nelnet.com/Nelnet.com - scan.json" "ARC Reports/Nelnet.com/Nelnet.com - scan 2026-08.json"
```

(Name it with the month, or with `latest` for a no-month run.) For several months, run them one after
another, copying after each. Large sources take several minutes (Nelnet.com is ~97 requests, ~4 min).
Run in the background and wait for the exit notification instead of polling.

## Step 3 — Check the files

For each file you produced, print what landed and flag anything wrong. `scanDate` is the date of the
scan the script actually found, so check it falls in the month that was asked for.

```bash
node -e "
const fs=require('fs');
for(const f of process.argv.slice(1)){
  if(!fs.existsSync(f)){console.log('MISSING',f);continue}
  const j=JSON.parse(fs.readFileSync(f,'utf8')), st=fs.statSync(f);
  console.log(f.split(/[\\\\/]/).pop(),'| source',j.source,'| scanDate',j.scanDate,'| standard',(j.standard||[]).length,'| contrast',(j.contrast||[]).length,'|',Math.round(st.size/1024)+' KB','| written',st.mtime.toISOString().slice(0,16));
  if(!j.source||!Array.isArray(j.standard)) console.log('  !! not an Allyway scan.json (needs source + standard[])');
  if(Date.now()-st.mtimeMs>3600e3) console.log('  !! older than an hour — did the script actually run for this one?');
  if(!(j.standard||[]).length&&!(j.contrast||[]).length) console.log('  !! no defects at all');
}" "ARC Reports/Nelnet.com/Nelnet.com - scan 2026-08.json"
```

(Substitute the real paths.) The `source` inside the file is what Allyway files it under, so it must
equal the tracked name exactly or a second, separate source gets created. If two files for the same
source report the same `scanDate`, the month didn't produce a distinct scan: say so.

## Step 4 — Hand back

Tell Teisha, in a few lines: which files are ready (source, scan date, counts), then the next steps:

1. Make sure you're on the VPN (if you turned it off, turn it back on).
2. Open Allyway, click **＋ Load scan.json**, and select the files (the button takes several).
3. **Order matters when loading several dates of one source.** Each load *replaces* that source's
   current scan and compares it with the previous one. Load them **oldest first, newest last** so the
   site ends on the latest scan and the history (trend, "what changed") builds in order. Loading an
   older scan last would make it the current one. If the file dialog doesn't preserve order, load
   them one at a time in date order.
4. Check the toast for each source (rules + contrast counts).

Do not commit `ARC Reports/`. Do not load into Allyway yourself over the MCP: pushing scan rows
through the model risks silently altering them; the Load scan.json button moves the bytes untouched.
