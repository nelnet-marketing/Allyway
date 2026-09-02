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

Site **admins** additionally get a **Review** button with a count of waiting reports. From the queue an
admin promotes a report to a GitHub issue or declines it — reporters cannot file issues themselves.
The verdict is a mutable `kind: "fbstatus"` dataset record keyed by submission id, so a decision is an
upsert rather than an append.

Promote opens a **pre-filled** issue on [wegnertm/Allyway](https://github.com/wegnertm/Allyway/issues)
labelled `feedback` plus the type (`bug` / `question` / `enhancement` / `accessibility`); nothing is
published until you press **Create** there. Two things to know:

- The sandbox cannot reach the GitHub API and a token cannot live in a public HTML file, so the app
  hands you an issue to confirm instead of filing one itself.
- The repo is public, so **the reporter's email is deliberately left out of the issue body** — it stays
  in Rideshare. Screenshots do not carry over either: download from the queue and drag them in.

Read the raw queue outside the app with the Rideshare MCP (`list_site_submissions allyway`), or
**Export CSV** from the queue dialog.

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
