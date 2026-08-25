# AccessibilityIQ — Rideshare Port Spec (v0.1 draft)

Status: draft, decisions pinned from design sessions Aug 2026. Open questions flagged at the end.
Owner: Teisha. Source tool: `AccessibilityIQ_v2.html` (standalone) + `latest-scan-export/index.js` (ARC export).

---

## 1. Purpose

Move the accessibility-scan triage tool off per-browser `localStorage` onto **Nelnet Rideshare** for shared hosting + server-side storage, and replace the unreliable auto lifecycle (new/recurring/resolved/regressed) with a **human-disposition model**: a person triages each finding once, and those decisions **carry forward** across monthly scans — suppressing known noise from the headline number while keeping the data auditable.

### Non-goals
- No automatic new/recurring/regressed classification (calibration showed it's noisy and low-value).
- No automatic "fixed" declaration (see §6 — "fixed" is a human claim the scan verifies).
- Phase A does not pull from ARC directly (see §9).

---

## 2. Core concept

Two layers, kept separate:

- **Scan snapshots** (facts): each uploaded report, reduced to per-finding rows. Append-only history.
- **Dispositions** (judgments): per finding, the human status + reason/assignee. Sticky; carried across scans.

Each new report is **reconciled** against the stored dispositions: findings you've suppressed drop out of the count; findings you haven't triaged surface for action; findings you marked Fixed get verified against the new scan.

---

## 3. Two tracking streams

Contrast behaves differently from everything else and is tracked as its own stream. Same status model applies to both.

| Stream | "Same finding" = fingerprint | Grouping unit | Notes |
|---|---|---|---|
| **Standard rules** | `ruleKey` (per source) | per rule | Rule key is stable; rule *title* is the human label. |
| **Contrast** (`1.4.3`, `1.4.11`) | **coarse signature** = `ruleKey + tag + sorted class list + role` (per source) | per styled-element pattern | Calibrated: the raw-markup signature churned on href/id noise; the coarse signature is stable for high-footprint patterns. A sitewide issue (e.g. `textWithBackgroundImage\|h1` on 159 pages) is ONE signature → one disposition suppresses all pages. Tool computes it client-side from the flat contrast export. |

Tracking is **bucketed per source** — a rule dispositioned for Client A is independent of Client B.

**Risk (see §11):** the contrast signature keys on class names. If a site uses build-hashed classes, the signature churns per deploy and contrast dispositions won't stick. Pending calibration with `--include-contrast`.

---

## 4. Status model

Every status answers two independent questions, giving **three carry-forward behaviors**:

| Status | Counts against score? | Returns to active list next month? | Bucket |
|---|---|---|---|
| **Untriaged** (default) | ✅ | ✅ | Active |
| **I need to fix** | ✅ | ✅ | Active — backlog |
| **In Progress** *(+ Assignee field)* | ✅ | ✅ | Active — being worked |
| **Needs approval** | ✅ | ✅ | Active — blocked on sign-off |
| **Deferred / backlog** | ✅ | ✅ | Active — parked for a known future project (own slate color, distinct from the green "actively working" group) |
| **Fixed** | ❌ | **only if still detected** | Verify (see §6) |
| **OK to ignore** *(+ reason)* | ❌ | ❌ † | Suppressed |
| **Not really an issue** | ❌ | ❌ † | Suppressed |
| **Can't fix — third party** *(+ X)* | ❌ | ❌ † | Suppressed |

† Unless the **footprint-jump guard** fires (§7).

### Status sub-fields
- **In Progress → Assignee** (free text / person). *Not* a per-person status — one status, an assignee field, so it scales past Jose/one team.
- **OK to ignore → reason**: `Best Practice` | `Low value / low risk`.
- **Not really an issue**: false positive; no sub-field.
- **Can't fix — third party → X**: **managed dropdown**, extensible. Seed values: `YouTube Video Player`, `Gravity Forms`, `HubSpot Form`. Stored as a category so we can report "N findings blocked by Gravity Forms" across all sources. **On Rideshare the list is admin-editable** (`NelnetStorage.viewer.isAdmin` gates add/rename/remove); non-admins select from it only. The list is a site-level managed dataset, not per-finding.

### Notes: two levels
- **Per-page note** — on each page row in the drill-down (per-instance later if needed).
- **Rule-level note** — at the top of a rule's drill-down ("applies to all pages"), e.g. "content redo Q4 will clear these." A 📝 marker shows on the collapsed rule row when one exists. Status-color grouping: 🟡 untriaged · 🟢 working (need-fix/in-progress/needs-approval) · 🔵 deferred · 🟩 fixed · 🔴 suppressed.

### Workflow statuses are a pipeline
`I need to fix → In Progress → Needs approval` are stages of the same thing (real issue, being remediated). They behave identically to the engine (count + re-surface); the distinction is for the human, not the math.

---

## 5. Reconciliation (the heart of it)

On upload of report **R** for source **S**:

**Dedupe first:** identify R by `scanId`. If `(S, scanId)` already ingested → reject (already have it). If a *different* scanId shares an existing `(S, date)` → warn (same-day double scan, e.g. the twin 2026-07-21 BenefitEd scans) and let the user pick which to keep.

**For each finding F in R** (matched by fingerprint per stream):

| Stored disposition D | Action |
|---|---|
| none (new to triage) | show in **Active** as Untriaged (counts) |
| workflow status | show in **Active** with that status (counts); update lastSeen + footprint |
| suppress status | route to **Suppressed** bucket (not counted, not shown in active); **footprint guard** (§7); update lastSeen + footprint |
| **Fixed**, but F is present | conflict → **"fix didn't take"** ⚠; return to Active for re-triage |

**For each finding previously seen but ABSENT in R:**

| Stored disposition D | Action |
|---|---|
| **Fixed** | **Confirmed fixed** ✅ — leaves Active, moves to Fixed bucket (this is a legit "count dropped" reason) |
| workflow status | **No longer detected (unverified)** — confidence by footprint (§7); surface for confirmation |
| suppress status | stays suppressed; no action |
| untriaged | **No longer detected (unverified)** — confidence by footprint |

---

## 6. The "Fixed" verify loop

"Fixed" is the one place a little cross-scan logic survives — the *trustworthy* kind (human claim + scan verification, not auto-detection):

1. Human/assignee marks a finding **Fixed** (immediately leaves the counted score).
2. Next scan:
   - finding **absent** → **Confirmed fixed** ✅
   - finding **still present** → **"fix didn't take"** ⚠ → back to Active

---

## 7. Footprint — confidence + escalation guard

Calibration established two things:
1. **Footprint, not elapsed time, is the reliability signal.** Low-footprint rules wink in and out for up to 6 scans with no real change; a time-based "fixed after N absences" threshold does not work (standard-rules calibration).
2. **Pages, not instances, is the stable footprint metric.** Contrast calibration: `color-contrast` instances went 109 → 392 (≈4×) while its *pages fell* 23 → 17. Instance counts are volatile (dynamic content, per-element counting); page counts (distinct URLs where the rule fires) barely move. **Lead confidence and thresholds with pages; treat instances as secondary.**

**Footprint tiers (page-first defaults; tune per source later):**
- **High / reliable**: ≥ 3 pages.
- **Low / noise-prone**: ≤ 2 pages (regardless of instance count).
- Instance count is a tiebreaker / display detail, not the primary gate.

**Uses:**
- **"No longer detected" confidence**: high-footprint disappearance → surface prominently ("likely resolved — confirm"); low-footprint → quiet ("no longer detected, may be noise"), keep tracking.
- **Escalation guard** (re-surfaces a suppressed finding): if a suppressed finding's footprint jumps — default **+≥ 3 pages, or pages ≥ 2×** — pop it back to Active flagged "escalated". (Instance-based jump is a weak secondary signal only.)

**Per-source / learned-over-time (deferred, but designed-for):** a single global page threshold is robust *because* pages are stable, so it ships as-is. Per-finding footprint **history is persisted** (§10) so a later version can learn each finding's own volatility band and flag changes relative to its own history — no data migration needed. Not built in Phase A.

**Re-review of suppressed items:** NOT a forced gate. An **opt-in nudge** — the tool counts suppressed items that either escalated (above) or have sat untouched for N months, and offers them for optional review. Same history data; never blocks.

---

## 8. Scoring & the "why did the count change" view

The headline number = **Active findings** (Untriaged + workflow statuses). Everything else is explained, not hidden:

- **Suppressed** — three visible sub-buckets: OK to ignore · Not really an issue · Can't fix (by X). Collapsible, auditable; count-down is explained, data retained.
- **Confirmed fixed** (this period) — marked Fixed + now absent.
- **No longer detected (unverified)** — absent, never marked fixed; flagged low/high confidence by footprint.

Every drop in the Active number traces to exactly one of these.

**Work-list export.** A one-click export of the *actionable* backlog to Excel, page-level, for sharing/hand-off. Two tabs, same columns (`Rule/Element · Stream · Page URL · Category/Severity · Instances · Status · Assignee · Note · Sample HTML`):
- **Work List** — statuses I-need-to-fix / In-progress / Needs-approval.
- **Deferred** — the Deferred/backlog status, kept separate so it doesn't clutter the to-do.
Excludes untriaged, fixed, and suppressed items. Standard + contrast + manual findings all included. (On Rideshare, downloads route through `NelnetStorage.downloadFile`, not a raw `<a download>`.)

---

## 9. Phasing

**Phase A — hosting + shared storage, upload-only** (no external dependency):
- Rideshare site (`storageEnabled`, mode `shared`).
- Port persistence off `localStorage` → `NelnetStorage` (§10).
- Contrast tracked as its own stream (net-new; current tool excludes it).
- Full status model + reconciliation + footprint logic.
- Drop the plaintext API-key storage (can't work in-sandbox anyway).
- Fix external links → `target="_blank"` / `NelnetOpen`.
- Upload = scan Excel from `index.js` — the **default** `node index.js KEY "Source"` now emits the tool-ready workbook (Detailed Findings + Contrast Detail); `--exclude-details` opts out. Disposition state lives in the site.

**Phase B — ARC pull server-side** (after platform admin approves `arc.tpgi.com`):
- Keyed endpoints ARE supported now; blocker is only endpoint approval.
- Repoint the fetch path to `NelnetConnect` (key stays server-side; CORS problem gone).
- Optional `connection_sync` schedule for hands-off refresh (writes a "latest" dataset; history still accrues via the store).

---

## 10. Storage model (logical → proposed NelnetStorage mapping)

*Logical:*
- **Dispositions**: one record per `(source, stream, fingerprint)` → `{ status, reason?, assignee?, xCategory?, firstTriaged, lastChanged, lastSeen, lastFootprint, history[] }`. Mutable.
- **Scan history**: per uploaded scan → per-finding rows `{ source, scanId, date, stream, fingerprint, ruleTitle, severity, category, instances, pages }`. Append-only.

*Proposed mapping (validate against `NelnetStorage` API):*
- Dispositions → **record collection**, upserted with `putRecords(rows, { replaceWhere: { source, fingerprint } })` on each status change. Page-writable by any viewer; mode `shared`.
- Scan history → record collection rows (type `scan`), appended via `putRecords` at upload; paged reads via `queryData`.
- Page never writes the site-dataset blob directly (not supported); all page writes go through `submit`/`putRecords`.
- Watch the 64 KB per-write cap; scan rows are rule-level (small). Contrast may add rows but still modest.

---

## 11. Open questions / risks

1. ~~Contrast signature stability~~ **Resolved (BenefitEd, 4 scans):** classes are NOT hashed. The raw-markup signature churned (avg ~0.56) on href/id noise + a 1-page tail. A **coarse signature** (ruleKey + tag + sorted class + role) is stable for high-footprint patterns — 24 multi-page signatures persisted across all scans, including sitewide issues like `textWithBackgroundImage\|h1` (159 pages). Decision: track contrast by coarse signature, page-first footprint gate (1-page = noise). No per-page fallback needed.
2. ~~Footprint thresholds~~ **Resolved:** page-first (§7). Global default ships; per-source learning deferred with history persisted.
3. ~~Escalation-guard sensitivity~~ **Resolved:** page-based (+≥3 pages / ≥2×) best-guess now, tune later.
4. **Upload sheet shape** — `index.js` emits several sheets (incl. grouped/subtotal rows). Confirm the parser ingests the flat per-URL sheet so subtotal rows don't skew counts. Contrast comes from the Contrast Summary sheet. *(Still open — needs Teisha's confirmation of which sheet.)*
5. ~~Status labels~~ **Resolved:** labels approved, UI-tunable; "Can't fix — X" list user-extensible.
6. ~~Re-review cadence~~ **Resolved:** no forced re-review; opt-in nudge (§7).

---

## 12. Decisions log (pinned)

- Fingerprint: rule key (standard) / element signature (contrast); bucketed per source.
- No auto lifecycle; disposition-carry + human-confirmed Fixed only.
- Three separate suppress buckets (not one status + reason).
- Contrast included as its own tracked stream.
- Dedupe uploads by `(source, scanId)`; warn on same-date duplicates.
- Footprint (not elapsed time) drives fixed-confidence and the escalation guard.
- **Pages (not instances) is the primary footprint metric** — instances are volatile, pages are stable (contrast calibration).
- Per-source / learned thresholds deferred; footprint history persisted so it's a no-migration upgrade.
- No forced re-review; opt-in nudge only.
- Assignee is a field, not a status.
- Storage: `NelnetStorage` records, mode `shared`; no `localStorage`, no in-page API key.
- **UI base = `tracker.html`** (rule-group + drill-down + Nelnet palette); swap its File System Access storage for `NelnetStorage` and its old lifecycle for the disposition model.
- Keep full page/HTML detail for the **current scan only**; history stores counts.

---

## 13. UI & design tokens

**Base:** `latest-scan-export/tracker.html` — keep its layout (rule-grouped table → expand to per-page rows → sample HTML snippet), its accessibility patterns (`:focus-visible`, `aria-expanded`/`aria-controls` on the drill-down toggle, `aria-label`led controls), and its palette. Replace: the File System Access persistence → `NelnetStorage`; the status pills/stat tiles (old lifecycle) → the §4 status dropdown + §8 buckets.

**Nelnet palette (from tracker.html `:root` — keep):**
| Token | Value |
|---|---|
| hero-green | `#AED136` |
| medium-green | `#70BA44` |
| dark-green | `#11891C` |
| gold | `#FDB913` |
| gray | `#A3AAAD` |
| dark-gray | `#565B64` |
| error-red | `#A80C59` |
| off-white | `#F7F8F4` |
| hairline | `#E6E8E3` |
| soft-fill | `#F0F4E8` |

Fonts: Red Hat Display (headings/labels) + Open Sans (body) — already loaded via Google Fonts (allowed on Rideshare/Artifacts).

**Rideshare visibility note:** mode `shared` means every viewer sees all findings, including page URLs + HTML snippets (client data). Confirmed acceptable — audience is internal staff only.

---

## 14. Rideshare-phase features (planned, not in the local prototype)

- **Admin-editable "Can't fix — X" list.** The managed third-party category list (§4) is add/rename/remove for admins (`viewer.isAdmin`), select-only for everyone else. Stored as a site-level dataset.
- **"Assigned to me" filter.** `NelnetStorage.viewer.email` identifies the logged-in user; the **In Progress → Assignee** field + author-stamped writes let a viewer (e.g. Jose) filter to their own assigned findings. Requested by Teisha; deferred but confirmed doable.
- **Triage import.** The prototype's exported `<source> - triage.json` imports into the Rideshare store so early local triage (e.g. BenefitEd) carries over — no re-doing.

---

## 15. Manual findings & observations

Human-found issues (spotted while viewing a page) that the scanner didn't surface. Added per-page from the drill-down ("＋ finding") or globally. A required **type** flag splits behavior:

| Type | Counts against a11y score? | Rationale |
|---|---|---|
| **Accessibility (scanner missed)** | ✅ yes — human-verified, high confidence | automated scans under-report; these are real defects |
| **Other observation** | ❌ no — firewalled into an Observations list | captured so it's not lost (vs. dropping in Workfront), but never touches the a11y number |

Behaviors (both types):
- **Never auto-resolved / never "no longer detected".** The scanner can't confirm them, so scan absence means nothing — they persist until a human closes them (Fixed / Won't-fix / etc.). Footprint logic (§7) does not apply.
- Same status lifecycle (§4) as scan findings; author-stamped on Rideshare.
- Attached to a page URL; stored outside the scan-derived `defects`, so they survive every new scan load.
- Included in `triage.json` export/import.

Decision (Teisha): include non-a11y observations despite minor scope creep — one capture point beats losing small items; the a11y score stays clean because observations are excluded from it.
