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
