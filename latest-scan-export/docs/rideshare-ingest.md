# Automated Rideshare ingest (no manual "Load scan.json")

Refresh Allyway's data on Rideshare without opening the site on VPN and uploading each
`scan.json` by hand. Everything below runs **off VPN**.

## Flow
```
node index.js                    # off VPN — generates ARC Reports/<source>/<source> - scan.json
node build-rideshare-records.mjs # -> rideshare-payload/<source>.json + manifest.json
# then push (below)
```

`build-rideshare-records.mjs` produces the exact records the tool reads — the same shapes
`ingestScanToStorage()` writes in `allyway.html`:
- `{ kind:'scan', source, scanDate, stream:'standard'|'contrast', ...defect }` — one per grouped defect
- `{ kind:'source', source, scanDate }` — the dashboard's source index

793 records total across all 18 sources today — tiny; storage cap is not a concern.

## Push (via the Rideshare connector, off VPN)
The record-collection API is reached through the Rideshare connector in a Claude session
(there is no standalone local token for it), so the push is a connector action, not a plain
CLI step. Ask Claude to "push the latest Allyway scans," or run it as a scheduled task.

For **each** source in `rideshare-payload/`, using its `<source>.json`:
1. `remove_site_data({ slug:'allyway', filter:{ kind:'scan',    source } })`
2. `remove_site_data({ slug:'allyway', filter:{ kind:'source',  source } })`
3. `remove_site_data({ slug:'allyway', filter:{ kind:'summary', source } })`  ← forces a fresh recompute
4. `add_site_data({ slug:'allyway', records: <payload.records> })`             ← includes the source record

Steps 1–3 are idempotent (they return `removed:0` when nothing matches). `add_site_data`
holds ~5 MB / a few thousand rows per call; every source here fits in one call.

### Invariant — never touch these
The push only replaces `kind:'scan'` / `kind:'source'` / `kind:'summary'`. It must **never**
remove or modify `kind:'disp'`, `kind:'manual'`, or `kind:'config'` — those are your triage
dispositions, manual findings, and settings. This is what lets a monthly re-scan drop in
fresh findings while every triage decision carries forward (same guarantee as the in-app
"Load scan.json", which also replaces only the scan slice).

## Approval
Writes to the live site require approval — the first push attempt is gated by Claude Code's
permission classifier. Approve it per run, or add a permission rule so the `add_site_data` /
`remove_site_data` connector calls for slug `allyway` are pre-allowed.

## Later: fully unattended (Phase B)
Once a platform admin approves `arc.tpgi.com` as a Rideshare connection, a `data_sync`
reminder can pull + refresh server-side on a schedule with no local run at all
(see `get_integration_guide` feature `data_sync`). Until then, this flow is the automation.
