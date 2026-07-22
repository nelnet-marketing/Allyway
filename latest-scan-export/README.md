# Latest Scan Export

Exports accessibility findings from the most recent ARC automated scan per source into an Excel workbook. Unlike the period-based `automated-scan-export`, this script targets a specific scan run, making it significantly faster.

## How it works

1. Resolves each source title to its data source ID via the ARC API.
2. Fetches the most recent completed scan for that source.
3. Retrieves all findings for that scan (paginated).
4. Excludes color contrast findings (WCAG 1.4.3 / 1.4.11) — see note below.
5. Enriches findings with WCAG criterion, description, and complementary guidance from the rules API.
6. Writes an Excel workbook with a **Scan Info** sheet, a **Summary** sheet, and a per-source **Findings** sheet.

## Note on Color Contrast findings

Color contrast errors are excluded. A single CSS change could produce thousands of contrast errors that overwhelm all other finding categories and can cause spreadsheet generation to fail. Additionally, a contrast error does not always represent a WCAG violation (e.g., a disabled control is exempt). See WCAG Understanding Docs for details.

## Prerequisites

- [Node.js](https://nodejs.org/) v14 or later
- An active ARC API key generated from the ARC Platform

## Installation

```bash
cd latest-scan-export
npm install
```

## Usage

### Most recent scan (default)

```bash
node index.js <ARC_API_KEY> "Source One, Source Two"
node index.js <ARC_API_KEY> "Source One, Source Two" --include-details
node index.js <ARC_API_KEY> "Source One, Source Two" --include-triage
node index.js <ARC_API_KEY> "Source One, Source Two" --include-details --include-triage
```

Fetches the single most recently completed scan for each source and exports its findings. `--include-details` and `--include-triage` are independent opt-in flags — pass either, both (in any order), or neither. The default output is unchanged when neither is set.

### Specific date range

```bash
node index.js <ARC_API_KEY> "Source One" --date-from=2025-01-01 --date-to=2025-01-31
```

Fetches the most recently completed scan within the given date range for each source.

| Argument | Required | Description |
|---|---|---|
| `argv[2]` | Yes | ARC API access token |
| `argv[3]` | Yes | Comma-separated list of source titles |
| `--date-from` | No | Earliest scan date to consider (`YYYY-MM-DD`) |
| `--date-to` | No | Latest scan date to consider (`YYYY-MM-DD`) |
| `--include-details` | No | Adds the per-instance **Detailed Findings** sheet |
| `--include-triage` | No | Adds the rule-grouped **Triage Report** sheet |
| `--page-size` | No | Starting findings-fetch page size (default `100`). Lower it (e.g. `--page-size=50`) for scans whose API connection drops repeatedly |

## Findings fetch resilience

The ARC findings endpoint sometimes closes the connection early on large pages,
especially at higher offsets. The fetcher handles this automatically:

- Each request has a 45s timeout so a stalled connection fails fast instead of hanging.
- On a dropped connection it retries the same page size twice (short backoff), then
  **halves the page size and keeps the smaller size** for the rest of the fetch —
  it does not reset to 100 on every page.
- After each source it logs a summary, e.g.
  `Fetched 8203 findings in 96.4s — 172 request(s), 5 retries, final page size 50`,
  so you can see whether a slow run is the fetch (many retries) or something else.

If a particular source drops constantly, start smaller with `--page-size=50`.

## Output

A single Excel file is written under `ARC Reports/`, named with the latest scan date (`MM_DD_YYYY`):

- `ARC Reports/<Source>/<Source> - <date>.xlsx` — single source
- `ARC Reports/Multiple Sources/<labels> - <date>.xlsx` — multiple sources

When opt-in flags are set, a suffix is appended so different runs don't overwrite each other (the default filename is unchanged when no flags are set):

| Flags | Suffix | Example |
|---|---|---|
| *(none)* | — | `CampusGuard - 07_22_2026.xlsx` |
| `--include-details` | ` - detailed` | `CampusGuard - 07_22_2026 - detailed.xlsx` |
| `--include-triage` | ` - triage` | `CampusGuard - 07_22_2026 - triage.xlsx` |
| both | ` - detailed-triage` | `CampusGuard - 07_22_2026 - detailed-triage.xlsx` |

### Sheets

| Sheet | Contents |
|---|---|
| **Scan Info** | Scan ID, date, findings count, and components scanned for each source |
| **Summary** | Finding counts grouped by Source × Engine × Rule, sorted by instance count |
| **Triage Report** | *(opt-in)* Findings grouped by rule, with expandable per-URL child rows (collapsed by default). Rows sort by Severity → Category → instance count. Matches the CampusGuard "Accessibility Triage" column format. |
| **\<Source\> - Findings** | Full per-instance detail including locator, HTML snippet, WCAG links |

## File overview

| File | Purpose |
|---|---|
| `index.js` | Main script — API calls, filtering, Excel generation |
| `data.js` | WCAG Knowledge Center URL mappings for guideline and test procedure links |
| `tests/` | Unit + round-trip tests for the Triage grouping and findings-fetch retry logic |

## Tests

```bash
npm test
```

Runs offline (no API key needed) — the fetch tests use a mocked page-fetcher and the triage tests round-trip a workbook through ExcelJS.
