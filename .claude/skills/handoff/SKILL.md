---
name: handoff
description: Draft the handoff email for one or more Allyway sources — either the full "accessibility review is complete" remediation handoff or a narrow ask for one person who holds access the team lacks (e.g. HubSpot). Pulls live counts from the Rideshare store, groups blocked items by root cause (full handoff) or counts a person's items by status (partial), and leaves an Outlook draft for review. Use when Teisha says "handoff Propelr", "draft the handoff email", "Propelr is ready to send to Jose", "email the PMs about ScholarNet", or names sources she has finished triaging.
---

# Allyway handoff email

Turns finished triage into a stakeholder email. The prose is the easy part — the value here is
that **every number comes from the live store**, never from memory or a stale export, and that
the blocked items arrive grouped by root cause instead of as a list of rule names.

Invoked as `/handoff Propelr`, `/handoff Propelr ScholarNet BenefitEd`, or with no arguments
(then ask which sources).

## Step 0 — Which kind of request?

After the sources are known, ask once (AskUserQuestion) which email this is, per source:

- **Full fixes** — the dev lead does the bulk of the remediation (e.g. an NBS site like Propelr).
  Use the main template, Steps 1–4 as written.
- **Partial fixes** — only a small slice goes to one person because they hold access she doesn't
  (BenefitEd in November 2026: Jose has HubSpot, she doesn't). Use the **Partial-fix variant**
  at the bottom of the template section. Skip Step 3 (no Needs Approval cluster); instead count
  that person's live items by status. Ask who it's for and what the access is.

Don't guess from the numbers — a site with few Active findings can still be a full handoff.

## Step 1 — Read the live numbers

For each named source, read its summary record:

```
list_site_data({ slug:'allyway', limit:5, filter:{ kind:'summary', source:'<Source>' } })
```

That gives `total`, `suppressed`, `active`, `verify`, `untriaged`, `triagedPct` — the fields
`saveSummary` writes (see `allyway.html`, the `kind:'summary'` putRecords call). Use these
verbatim. Do not recompute them and do not round.

`verify` is the one that's easy to skip past, and Step 2 branches the whole email on it. Read
it every time.

If a source has no summary record, it has never been saved since the summary math last
changed — open it in the app once to regenerate, or say so rather than guessing.

### Reading dispositions — page UNFILTERED

To get the items needing action, read the store **without a filter** and match locally:

```
list_site_data({ slug:'allyway', limit:200 })   // follow `cursor` until null, then filter in JS
```

**Never page a filtered query to collect dispositions.** A filtered `list_site_data` parks its
next cursor at the last row *scanned*, not the last row *returned*, so once a page fills its
limit the rest of that scan window is skipped silently. That is the bug that made the app
report half of Propelr's triage as untriaged (see `docs/rideshare-backup.md`). Quoting a
truncated count to a stakeholder is the worst possible place for it to resurface.

A single small filtered read is fine when you expect fewer rows than the limit — e.g. one
source's `needs_approval` items. Anything that could exceed the limit gets the unfiltered pass.

**Drop out-of-scope pages before counting anything.** Disposition rows on a page that's out of
scope still carry their old status. A page is out of scope if any row on it is `out_of_scope`,
or if it's linked "Same as" a finding that is (`excludedUrlsFor` in `allyway.html`). On
BenefitEd in November 2026, 221 `needs_approval` rows sat on redirected resource pages that were
all out of scope — the live Needs Approval count was 0. Counting raw rows would have put a
false question to the dev. Resolve each row's status the way `computeSummary` does (excluded
URL → out of scope, then Same-as target, then page row, then rule row) and count only what's live.

If the summary disagrees with the in-app counts, the summary is wrong, not the app: before
November 2026 `computeSummary` ignored Same-as exclusions (fixed — one shared helper now).

## Step 2 — Pre-flight checks

Run these before drafting and report what you find:

1. **`untriaged` must be 0.** If not, the source is not ready to hand off. Say how many are
   left and stop — do not draft an email claiming a review is complete when it isn't.
2. **Check which email this actually is.** Read `active` and `verify` together:
   - `active > 0` → a **remediation handoff**, the main template below.
   - `active` is 0 and `verify > 0` → **not a handoff at all.** Those are items marked Fixed
     and awaiting confirmation, so the ask is verification, not development. Use the
     verification variant. ScholarNet in September 2026 was exactly this: `active: 0,
     verify: 13` — the main template would have promised 0 findings to remediate and never
     mentioned the 13 things actually waiting on someone.
   - both 0 → nothing to say; tell her the source is fully closed out.
3. **Every active disposition needs an assignee.** Read the `need_fix`, `in_progress` and
   `needs_approval` dispositions and list any missing one. The email says "assigned to you";
   that has to be true. This nearly went out wrong once.
4. **Check the summary's `updatedAt` against the newest disposition's `createdAt`.** If a
   disposition is newer than the summary, the summary is stale — the numbers will understate
   the work. Have her open the source in the app to recompute, then re-read.

## Step 3 — Group the blocked items by root cause

(Full-fix emails only. If there are no *live* Needs Approval items, cluster the live `question`
items the same way — BenefitEd's were third-party widgets: the HubSpot chat and a video player.)

Read the `needs_approval` dispositions for the source:

```
list_site_data({ slug:'allyway', limit:100, filter:{ kind:'disp', source:'<Source>', status:'needs_approval' } })
```

Then read their `notes` and cluster them by the underlying cause, not by rule name. The notes
carry the real question. For Propelr in September 2026, ten of eleven items traced to one
Storylane demo iframe on `/products` — notes like *"can we fix anything on Storylane
`<iframe>`?"* and *"Do we have any control over Storylane? Otherwise mark this as Can't Fix."*
Nine separate rule names, one decision.

State the cluster and the decision it needs. If items don't cluster, list them plainly rather
than inventing a theme. When a cluster sits on one page, name the page the way a reader would
say it ("the Products page"), not the path — she wrote it that way, and the recipient is
navigating the site, not a URL list.

## Step 4 — Draft it

Use the template below, filled with the live numbers. Then create an Outlook draft:

```
CreateDraftMessage  → subject, body, To: Jose, Cc: Felicia, Mike, Ryan, Randall
```

**Never send.** She reviews and sends.

### Who it goes to

**Full-fix handoff** — the same five every time, whatever sources are in the email:

- **To:** Jose, the dev lead who owns remediation.
- **Cc:** Felicia (PM), plus Mike, Ryan and Randall.

Kylie was on the September 2026 Propelr email but is deliberately off this list — she may no
longer be at Nelnet. Don't add her back. The Cc isn't per-source; a multi-source email doesn't
change it.

**Partial-fix request** — To is whoever holds the access. Don't assume the standing Cc: it's a
narrow ask to one person, so ask her whether to drop the Cc or keep it.

**First names only, deliberately — no addresses in this file.** Resolve the names and show her
the resolved list before creating the draft. `search_people` needs `People.Read`, which the
connector may not have; if it 403s, read the sent Propelr email (`SearchMessages`) for full
names, and let `CreateDraftMessage` resolve them. Then **check the draft's returned Cc against
the list** — a name that doesn't resolve is dropped silently (that's how Kylie went missing).
Never guess or construct an address from a pattern; a wrong one either bounces or reaches a
stranger. If a name resolves to more than one person, ask rather than picking.

**Edits to a draft she has open get overwritten.** If she's editing the draft in Outlook, an
`UpdateDraft` is accepted and then clobbered by her autosave. Ask her to close it first, or give
her the text to paste.

## Template

This is calibrated against the Propelr handoff she actually sent in September 2026, not a
guess at her voice. Deviate only when the data calls for it.

Single source:

```
Subject: <Source> accessibility review complete — <active> items ready for remediation

Hi <Name>,

I reviewed <total> automated findings and ruled out <suppressed> as false positives or
non-issues, leaving <active> Active findings. All are documented in Allyway -> <Source> card
with notes/remediation guidance and are assigned to you.

For anyone unfamiliar, Allyway is the tool I'm building to track accessibility findings and
remediation work. Currently hosted on Nelnet Rideshare so you'll need to be on the VPN to
access it. Reach out if you have any issues.

One question for you: Most of the items I marked as "Needs Approval" are due to <root cause>
on the <page> page. <the decision question>? If not, I can mark those findings as "Can't Fix"
and remove them from the Active findings list.

Happy to walk through anything if that would be helpful 🙂
```

What that template gets right, and why each piece is there:

- **No "the review is complete" opener.** She leads straight with the number. The subject line
  already said it's complete.
- **"the tool I'm building"**, not "using". It's hers.
- **The VPN sentence is not optional.** Allyway is behind Rideshare; a recipient off VPN just
  gets a dead link and no explanation. She pairs it with an offer to help.
- **No URL in the body.** She pointed at the location instead ("Allyway -> <Source> card").
  Adding the raw link is fine if she asks, but the VPN note is what actually unblocks people.
- **"One question for you:"** — the blocked cluster is framed as a single explicit ask, not
  buried in a hedge. Drop the old "that number may come down slightly" phrasing; naming the
  count and asking the question outright is stronger.
- **No paragraph explaining the Cc.** They're copied; she doesn't narrate it.
- **Emoji in the closing.** Keep it. The sign-off is short and warm, not a formal offer to
  schedule a walkthrough.
- **"Active findings"** capitalized the way the app labels it.

If `verify` is above 0 alongside active work, add a line for it — those are items already marked
Fixed that still need someone to confirm the fix shipped, and they're easy to lose track of:

```
<verify> items are marked Fixed and just need confirmation that the change is live.
```

Verification variant — when `active` is 0 and `verify` is above 0:

```
Subject: <Source> — <verify> accessibility fixes ready to confirm

Hi <Name>,

Good news on <Source>: there's nothing left to remediate. Of <total> findings reviewed,
<suppressed> were ruled out and the remaining <verify> are already marked Fixed.

What I need is confirmation those changes are actually live, so I can close them out. They're
in Allyway -> <Source> card and each one has a note about what was changed. It's hosted on
Nelnet Rideshare, so you'll need to be on the VPN — reach out if you have any issues.

Once you confirm, <Source> is fully closed for this review cycle 🙂
```

### Partial-fix variant

For a narrow ask to one person who holds access she doesn't. Calibrated against her own final
version of the BenefitEd email to Jose (November 2026). Numbers are *that person's live items*, split
by status — not the site totals. Count only items assigned to them after dropping out-of-scope
pages, and only the ones that really are the third-party slice (BenefitEd: 17 HubSpot items,
4 Need to Fix + 13 Question; the other live items belonged to Matt Stanley and were not part of
this ask).

```
Subject: <Source> <Mon> ARC Scan Results

Hi <Name>,

I found <n> <third-party> issues during my ARC Scan triage of <Source>: <a> marked “Need to fix” and <b> marked “Question”. I’ve assigned them all to you in Allyway. You’ll need to be on the VPN, so let me know if you don’t have access.

Could you take a look and let me know if we can fix them?

If you fix something, reassign it back to me and/or update the status to “In review.”

If we can’t fix it, add a note explaining why, set the status to “Can’t fix — third party,” and choose “<reason>” under “Blocked by” (or whatever option makes the most sense).

I know you have <their other project> on your plate, so just let me know when you think you’ll be able to get to these.

Happy to walk through anything if that would be helpful 🙂

Thanks,
```

`<Mon>` is the month of the scan being triaged (BenefitEd: "Oct"). Stop at "Thanks," — her Outlook
signature is appended automatically, so don't type a name block into the body.

Things her version gets right, and the traps in the first draft:

- **Short, separate paragraphs** — the ask, the fix path and the can't-fix path each get their own
  line so a dev can scan them. Don't merge them back into one block.
- **No `#<source>` deep link.** The app has no hash routing and Rideshare's iframe swallows the
  hash, so it lands on the dashboard. Just say "in Allyway".
- **VPN note with an offer to help** ("let me know if you don't have access"). Keep it.
- **Use the app's exact labels:** status "Can't fix — third party"; the picker is called
  "Blocked by"; the option is "HubSpot Form" (not "Hubspot"); "In review".
- **Name what the items really are** — BenefitEd's were HubSpot forms *and* the HubSpot chat,
  so "form and chat", not "form".
- **Ask when, not how long** ("let me know when you think you'll be able to get to these") and
  acknowledge their workload — it's a favour on top of a full plate, not a handoff.
- Confirm every item is assigned to that person before saying "I've assigned them all to you";
  items that belong to someone else (BenefitEd: Matt Stanley's Sprout video and 404 redirects)
  aren't in it.

Multiple sources: keep the opening and closing, and give each source its own short paragraph
with its own counts and its own blocked-items question. Put the source with the most active
findings first. Don't merge their numbers into a single total — PM planning is per site. Sources
in the verification state get their own paragraph too — don't drop them because they have no
active work, and don't imply someone needs to write code for them.

## Rules

- Every figure traces to a live read. If something can't be verified, say so instead of
  hedging vaguely — "I couldn't confirm this number" beats a confident wrong one.
- Name the Needs Approval count. Don't reach for "slightly" — she cut that hedge and asked the
  question outright instead.
- Keep her voice: plain, direct, one clear ask, no corporate padding. The 525 → 488 → 39
  framing does real work — it shows the triage effort rather than just the leftovers.
- Match the app's own labels ("Needs Approval", "Can't Fix", "Active findings") so a reader
  isn't hunting for UI that doesn't exist under that name.
- **Allyway needs the VPN.** It's hosted on Nelnet Rideshare, so say so in every email —
  otherwise an off-VPN recipient gets a dead link and no idea why.
- Beyond the VPN, access is per-site. If someone on VPN still can't open it, check the site's
  viewer list — an internal site with no viewers and no groups admits any signed-in Nelnet
  user, but an explicit viewer list locks everyone else out. There is no MCP tool that reads
  the list back, so this has to be confirmed in the portal.
- Storage is in **shared** mode, so recipients can write, not just read. If a dev marks items
  fixed, their rows shadow hers for those findings. That is intended — mention it only if she
  asks why statuses moved.

## After sending

Suggest re-exporting **Back up triage (CSV)** for each source once the handoff is out, so the
snapshot on disk matches what the stakeholders were told. An export taken mid-session goes
stale fast — one taken at 20:15 already misread her own 20:50 triage.
