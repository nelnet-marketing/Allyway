---
name: handoff
description: Draft the "accessibility review is complete" handoff email for one or more Allyway sources. Pulls live counts and blocked items from the Rideshare store, groups the Needs Approval items by root cause, and leaves an Outlook draft for review. Use when Teisha says "handoff Propelr", "draft the handoff email", "Propelr is ready to send to Jose", "email the PMs about ScholarNet", or names sources she has finished triaging.
---

# Allyway handoff email

Turns finished triage into a stakeholder email. The prose is the easy part — the value here is
that **every number comes from the live store**, never from memory or a stale export, and that
the blocked items arrive grouped by root cause instead of as a list of rule names.

Invoked as `/handoff Propelr`, `/handoff Propelr ScholarNet BenefitEd`, or with no arguments
(then ask which sources).

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
CreateDraftMessage  → subject, body, To: Jose, Cc: Felicia, Kylie, Mike, Ryan, Randall
```

**Never send.** She reviews and sends.

### Who it goes to

The same six every time, whatever sources are in the email — don't re-ask her:

- **To:** Jose, the dev lead who owns remediation.
- **Cc:** Felicia and Kylie, the two PMs, plus Mike, Ryan and Randall.

The PMs are not per-source. Both are copied on every handoff, and a multi-source email doesn't
change the Cc.

**First names only, deliberately — no addresses in this file.** Resolve each name through the
Microsoft 365 people tools at draft time and show her the resolved list before creating the
draft. Never guess or construct an address from a pattern; a wrong one either bounces or
reaches a stranger. If a name resolves to more than one person, ask rather than picking.

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

Multiple sources: keep the opening and closing, and give each source its own short paragraph
with its own counts and its own blocked-items question. Put the source with the most active
findings first. Don't merge their numbers into a single total — the PMs plan per site. Sources
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
