# Backing up Allyway's Rideshare data

The Rideshare store is the **only** copy of Allyway's triage. `allyway.html` lives in git;
the data does not, and nothing on the platform mirrors it off-site. This is the procedure
that takes a snapshot.

Snapshots land in `backups/<date>/` and are **gitignored** — this repo is for code, not data.

## What is worth backing up

**The triage work** — the decisions, and the prose attached to them. Everything else either
regenerates from ARC or is a UI convenience.

| Kind | Rows | Effective | Keep? |
|---|---|---|---|
| `disp` | 281 | 239 | **Yes** — the disposition per rule/page: status, `reason`, `xcat`, `assignee`, `notes`, `fix` |
| `manual` | 5 | 5 | **Yes** — hand-entered findings, with their own `fix` instructions |
| `config` | 3 | 1 | **Yes** — the `xcats` list; without it `cant_fix` rows lose their category labels |
| `scan`, `source` | 793 | — | No — `npm run scan:rideshare` rebuilds these |
| `summary` | 18 | — | No — recomputed from `disp` on save |
| `pref`, `lastview` | 4 | — | No — theme and last-opened source, per viewer |
| `fbstatus` + submissions | 12 | 12 | Separate concern — the feedback board, not triage |

245 effective triage items out of 1110 stored records. Of those, **201 carry a note, 12 carry
written fix instructions, 28 carry an assignee** — that is the part that would hurt to redo.

The gap between 281 stored and 239 effective dispositions is 43 superseded rows (the same
`dkey` saved more than once, newest wins) plus one deliberately cleared tombstone. ScholarNet
in particular holds two complete generations of its 39 decisions — Teisha's from Aug 28 and
Samuel's from Aug 31.

## Taking a snapshot — the everyday way

**Back up triage (CSV)**, next to *Export work list* in the source view. One click, per source.
It writes `<Source> - triage backup.csv`: every disposition that has been **set** (untriaged
items have no row to export), plus manual findings at any status, plus the `xcats` list.

The column that matters is **`dkey`**. It is the key a restore writes back to, and it is why
the work-list CSV can't serve as a backup — that export identifies a finding by rule title,
which for contrast drops the `textWithBackgroundImage|` prefix off the front of the real key.
The work list also only covers 4 of the 8 statuses: measured on 2026-09-03 it captured 29 of
239 decisions, leaving out every `not_issue` / `ok_ignore` / `fixed` / `cant_fix` call and the
reasoning attached to them.

Do this before any bulk re-triage, and before a monthly scan push.

## Taking a full snapshot — everything, all sources

The button is per-source and covers triage only. For the whole store — every source at once,
plus feedback and the raw records — there is no standalone local token for the record API
(see `rideshare-ingest.md`), so this runs as a connector action in a Claude session: ask
Claude to "back up the Allyway data," or run it as a scheduled task.

### 1. Records — page with NO filter

```
list_site_data({ slug:'allyway', limit:200 })            # then follow `cursor` until null
```

**Do not pass a `filter` while paging.** Filtered pagination silently drops rows (see the
warning below). Page the whole store unfiltered and split by `kind` locally — that is the
only read path that returns every row.

### 2. Submissions

```
list_site_submissions({ slug:'allyway', limit:100 })     # follow `cursor` until null
```

### 3. Blob datasets

```
get_site_data({ slug:'allyway' })                        # inventory, then one read per key
```

### 4. Write it out

Resolve to newest-per-key first — key on `source`+`dkey` for `disp`, `source`+`mid` for
`manual`, `source`+`ckey` for `config` — exactly as `newestByKey()` does in the app. A row
carrying nothing but its own key is a tombstone: a deliberately cleared decision, so keep it
as a clear rather than reviving the row it replaced.

- **`restore-payload.json`** — the one that matters. Bare `data` objects, deduped, ready to
  hand straight to `add_site_data`.
- `triage-resolved.json` — the same records with ids, authors and timestamps
- `triage-records.json` — all raw work rows including superseded generations, full fidelity
- `triage-work.csv` — readable: rule, page, status, reason, xcat, assignee, note, fix
- `records-all.json` — every record verbatim, safety net
- `submissions.json`, `feedback-status.json`, `datasets.json`
- `manifest.json` — counts per kind and per source, so drift is obvious next time

Compare `manifest.json` against the prior snapshot. A drop in effective `disp` for a source
nobody re-triaged means something ate rows.

## Restoring

```
add_site_data({ slug:'allyway', records: <restore-payload.json .records> })
```

`add_site_data` appends; it does not overwrite. Because `newestByKey()` takes the newest row
per key, re-adding the payload reinstates every decision without deleting anything that is
already there. Restoring the resolved payload rather than the raw rows also collapses the
duplicate generations instead of resurrecting them.

Restore only what you mean to. **Never bulk-remove `disp`** — the scan push is allowed to
replace `scan`/`source`/`summary` and nothing else (see `rideshare-ingest.md`).

To rebuild the regenerable half afterwards: `npm run scan:rideshare`, then push per
`rideshare-ingest.md`.

## ⚠️ Filtered pagination drops rows

`list_site_data` / `queryData` set the next `cursor` to the last row **scanned**, not the
last row **returned**. When a filtered page fills up, every match between the last returned
row and the end of the scan window is skipped permanently.

Measured on 2026-09-03:

```
list_site_data(filter:{kind:'disp'}, limit:200)   -> count 200, scanned 721, cursor C
list_site_data(filter:{kind:'disp'}, cursor:C)    -> count 0,   scanned 389, cursor null
```

That reports 200 dispositions. The store holds **281**. 81 rows (29%) are unreachable that
way, yet each one reads back fine when queried by source:

```
list_site_data(filter:{kind:'disp', source:'ScholarNet'})  -> count 78   # all present
```

**This also affects the live app.** `queryAll()` in `allyway.html` pages at `limit:100` with
`{kind:'disp', source}`. For Propelr — 200 dispositions — page 1 returns 100 rows ending at
id `1788380261235`, but hands back a cursor at id `1787762437821` (six days older than every
Propelr row). Page 2 therefore returns 0 and paging stops. **The app loads 100 of Propelr's
200 dispositions.** The other half is in the store, intact, and invisible in the UI.

Any source under ~100 dispositions is unaffected, which is why this went unnoticed.

Mapping the store confirms the mechanism. All 281 `disp` rows sit in positions 2–317 of 1110,
and the 200th is at position 208 — but a filtered page reports `scanned: 721`. The server
sweeps a fixed ~720-row window, returns the first `limit` matches, then parks the cursor at
the end of the **window** rather than at the last row it returned. Positions 209–721 are
scanned, unreturned, and never revisited. Page 2 resumes at 722, where no `disp` rows remain.

### Fixed

`queryAll()` now pages **unfiltered** and matches locally, and one shared snapshot serves all
the concurrent reads of a single load (`readAllRows` + `invalidateRows`). Unfiltered reads are
a plain range scan whose cursor lands on the last row *returned*, so nothing is skipped. Every
write calls `invalidateRows()`; without it the next read serves the pre-write snapshot.

`loadFeedback()` had the same shape against the submission store and got the same treatment —
harmless at 6 reports, but it would have dropped them past 100.

`tests/queryall.test.mjs` extracts the shipped `queryAll` and runs it against a stub that
reproduces the window-and-cursor behavior above, asserting the old path returns 100 of 200
Propelr dispositions and the new one returns all 200. `tests/export.test.mjs` does the same
for `collectTriage()`, checking that `dkey` survives verbatim and that nothing is dropped for
having a status the work list ignores.

**Why the read fix had to land first:** both CSV exports build from `state.dispositions`,
which `queryAll` fills. Before the fix, *any* export — including the backup button — would
have written out 100 of Propelr's 200 decisions and looked complete.

One instance is left alone deliberately: the boot-time theme lookup does a filtered
`queryData({limit:1})` for the viewer's `pref` row. It can miss the row if it falls outside the
first window, but the only consequence is the theme defaulting, and routing it through
`queryAll` would pull the whole store at boot just to read a colour.
