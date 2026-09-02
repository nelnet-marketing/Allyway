# Allyway

Nelnet accessibility triage. **Allyway** is a self-contained web app for triaging automated
accessibility findings, deployed as an internal Rideshare site
(`https://rideshare-internal.nelnettools.com/allyway/`). This repo holds the app plus the
Node pipeline that pulls scans from the [ARC](https://www.tpgi.com/arc-platform/) API and
ingests them into Rideshare.

## Layout

| Path | Purpose |
|---|---|
| `allyway.html` | The deployed app — one self-contained HTML file (inline CSS/JS, embedded fonts). Persists per-viewer state via NelnetStorage. |
| `index.js` | Pulls the latest ARC scan per source → writes a grouped `<Source> - scan.json` (and an Excel export). Uses `data.js` for WCAG links. |
| `build-rideshare-records.mjs` | Turns `scan.json` files into Rideshare storage records under `rideshare-payload/`. |
| `calibrate.mjs`, `calibrate-contrast.mjs` | Calibration pulls (rule history / contrast signatures) used to tune "fixed" detection. Output under `calibration/`. |
| `tests/` | Offline unit + round-trip tests for the triage grouping and findings-fetch retry logic. |
| `docs/` | `rideshare-ingest.md` (ingest runbook) and design notes. |

Generated/ignored: `node_modules/`, `ARC Reports/`, `rideshare-payload/`, `calibration/`, `*.xlsx`.

## Prerequisites

- [Node.js](https://nodejs.org/) v14+
- An active ARC API key (from the ARC Platform). Keys expire ~every 90 days.

```bash
npm install
```

## Pull scans and ingest to Rideshare

```bash
# Fetch the latest ARC scan per source → scan.json (+ Excel)
node index.js <ARC_API_KEY> "Source One, Source Two"

# Build Rideshare records from the scan.json files
npm run records:rideshare

# Or both in one step
npm run scan:rideshare
```

`index.js` also supports `--date-from` / `--date-to`, `--include-details`, `--include-triage`,
and `--page-size` (lower it for scans whose ARC connection drops). See `docs/` for the ingest
runbook.

## Feedback

Every viewer gets a **Feedback** button in the header: type, severity, one description, and an
optional screenshot (file picker or Ctrl+V paste). Context — source, view, theme, viewport, browser,
timestamp — is captured automatically, so nobody has to describe their own setup. Reports land in the
Rideshare submission store as `kind: "feedback"` rows; screenshots go to the site file store.

Site **admins** additionally get a **Review** button with a count of waiting reports. It opens a
**board**: four columns, **New → Accepted → In progress → Done**. Drag a card between columns to move
it — the drop is the commit, and dragging it back is the undo. **Group by** lays the same board out as
swimlanes banded by severity or type; **Sort cards** orders within each column. **Declined** is a
collapsed lane under the board and is not a drop target.

Drag alone would fail [2.1.1 Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard) and
[2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements), so every
card also carries a **stage select** that doubles as its stage read-out. That one control covers the
keyboard, screen readers, and single-pointer users on touch, where HTML5 drag does not work at all.
Toasts carry `role="status"` so a move is announced; the board itself is deliberately *not* a live
region, or every re-render would read the whole board aloud.

Moving a card saves immediately. **Decline** and **Delete** still stage a confirm with an optional
**note**, because neither is undone by dragging the card back. Notes live on the mutable `fbstatus`
record and can be re-edited any time; the reporter's original text is never rewritten, since the
submission store is append-only.

The stage is a mutable `kind: "fbstatus"` dataset record keyed by submission id, so a decision is an
upsert rather than an append. The **Review** badge counts only **New**, so accepted work stops nagging.

Declined reports can be **deleted permanently** (report + note + screenshot, behind a confirm step),
and are swept automatically `RETENTION_DAYS` after the decline — 14 by default, `0` disables it. The
sweep is opportunistic: there is no server-side cron for submissions, so it runs when an admin opens
the queue, and reports what it cleared. A swept or deleted report leaves a bare `status:"deleted"`
tombstone so the note cannot outlive the report it describes.

**This queue used to push reports to GitHub issues; it no longer does.** The issues it created were a
lossier copy of the board — no screenshot, no reporter, no note — and nothing ever linked them to a
commit or PR, so the round trip only cost a manual step per report. Rideshare is now the whole system
of record for feedback. The repo still hosts the code; it just isn't a tracker. Rows written under the
old flow stored `status: "promoted"`, and `stageOf` reads those as **Accepted** so they keep a column
instead of vanishing off the board.

Because nothing mirrors the queue off-platform any more, the Rideshare store is the only copy — read
it outside the app with the Rideshare MCP (`list_site_submissions allyway`) or **Export CSV** from the
board.

## Deploy the app


`allyway.html` is published to the Rideshare `allyway` site. On Windows, PUT the file to a
presigned upload URL with PowerShell (curl's schannel revocation check fails), then publish:

```powershell
Invoke-WebRequest -Uri $uploadUrl -Method Put -InFile allyway.html -ContentType 'text/html' -UseBasicParsing
```

## Tests

```bash
npm test
```

Runs offline — no API key needed (fetch tests use a mocked page-fetcher; triage tests
round-trip a workbook through ExcelJS).

## License

MIT — see [LICENSE](LICENSE). Portions derived from TPGi's `latest-scan-export` example.
