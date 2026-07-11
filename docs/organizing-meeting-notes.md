# Organizing meeting notes: strategy proposal

Status: accepted; implemented in #42.

## Decisions

- No series hub note (open question 1): a new occurrence follows the most recent note's folder (item 2 below), not a dedicated anchor file.
- No "where should this series live?" prompt (open question 2): folder resolution is deterministic, so there's nothing to ask.
- 1:1s are first-class (open question 3), behind a "Handle 1:1s separately" toggle, off by default. When it's on, a 1:1 gets its own per-person folder under a configurable "One-on-one folder" setting instead of following the series/one-off rules.
- Ad-hoc meetings get their own "Ad-hoc meetings folder" setting (open question 4) rather than sharing the one-off template.

## The problem

Today the plugin files notes like this:

- One-off meetings land flat in the base folder (`Meetings/`).
- Recurring meetings get a per-series subfolder, `Meetings/<Series Title>/`, with the folder name re-derived from the event summary on every occurrence.

That breaks down in three ways:

1. **The flat list doesn't scale.** A few months of one-offs is already dozens of files in one folder.
2. **Moving things loses the plugin.** The agenda sidebar finds notes by `event_id` frontmatter anywhere in the vault, so it survives moves. But the create paths (`startMeetingRecording`, scheduler auto-record) resolve by computed path only: move a note, hit "create note and record" for that event again, and you get a duplicate in the default location. Move or rename a series folder and the next occurrence recreates the old folder under `Meetings/`.
3. **Organization is after the fact.** There's no way to say "1:1s go here, client calls go there" up front; you can only shuffle files later, and per point 2 that shuffling isn't safe.

## Principles

1. **Identity lives in frontmatter; location belongs to the user.** Notes already carry `event_id`, `ical_uid`, and `recurring_event_id`. The plugin picks a default location for *new* notes and never insists on it afterward.
2. **Every lookup goes by id first.** No code path may assume a note's path from settings.
3. **New occurrences follow the series wherever it lives now.**
4. **Prefer routing at creation time over reorganizing later**, but ship a migration command for the existing mess.
5. **The vault is the only state.** No side mapping in `data.json` from series id to folder: plugin-local state doesn't sync across devices and silently rots when folders move outside Obsidian.

## Proposal

### 1. Resolve notes by identity everywhere (prerequisite, bug fix)

Before creating a note, every create path consults the `event_id` index the agenda already builds (`buildNoteIndex`). If a note for that event exists anywhere in the vault, reuse it. Make the index a shared, cached structure kept fresh via `metadataCache` events instead of a rescan per call.

This alone makes "move a note anywhere" safe.

### 2. Sticky series homes

A series is identified by `recurring_event_id`. When creating a note for a new occurrence, place it in the folder that currently holds the series (resolution order in item 3). Consequences:

- Move the series folder to `Projects/Acme/Meetings/Weekly sync/` and the next occurrence lands there.
- Rename the series in Google Calendar and notes keep landing with their siblings; the folder name is yours to change whenever.

For a series with no notes yet, fall through to routing rules (item 5), then the default folder template (item 4).

### 3. Series hub note

On the first occurrence of a series, create a folder note alongside it: `<folder>/<Series>.md` with `recurring_event_id` in frontmatter, series metadata, and an occurrence list (a Bases/Dataview query over `recurring_event_id`, matching how the dashboard already queries frontmatter). It's the natural place for a standing agenda and running action items across occurrences.

The hub doubles as the series anchor: **new occurrences are created next to the hub note**. If no hub exists (pre-existing series, user deleted it), fall back to the folder of the most recent note with that `recurring_event_id`. This keeps the anchor deterministic, syncable with the vault, and visible to the user, with zero hidden state.

### 4. Folder path templates

Replace the single `meetingsFolder` string with two templates using the existing `{{placeholder}}` engine:

- One-offs, default `Meetings/{{year}}`
- Series, default `Meetings/{{series}}`

Tokens: `{{year}}`, `{{month}}`, `{{date}}`, `{{title}}`, `{{series}}`, `{{organizer_domain}}`. Users who want month sharding, per-client trees, or the old flat layout set it here. Date sharding by year is enough to keep one-off folders bounded without burying files two levels deep.

### 5. Routing rules

An ordered rule list in settings, evaluated at note creation, first match wins:

- Match on: title (substring or regex), attendee or organizer email/domain, calendar id.
- Target: a folder template (same tokens as item 4).

Examples:

```
title ~ "1:1"                 -> Meetings/1-1s/{{series}}
organizer ~ "@acme.com"       -> Clients/Acme/Meetings
calendar = "team@elastic.co"  -> Meetings/Team/{{year}}
```

Optional (setting, default on): when a *new series* matches no rule, ask once with a folder picker, "Where should this series live?", and create the hub note there. One question per series, never per occurrence.

### 6. Moves keep note and recording together

The recording is saved next to the note with the same basename. Listen to `vault.on("rename")`: when a meeting note moves, move the colocated recording with it (offer or auto, behind a setting), and the same in reverse. Links are wikilinks so nothing breaks in between; this just preserves the colocation that retention cleanup and `findMeetingNoteForAudio` prefer.

### 7. Migration command

"Organize existing meetings": applies routing rules and series grouping to every existing meeting note, shows a dry-run from/to list, then moves notes together with their recordings. This is the after-the-fact companion for vaults that predate routing.

## Rollout order

Each step is independently shippable:

1. Identity-first resolution (smallest change, fixes duplicate-on-move).
2. Sticky series home via most-recent-note (no new UI yet).
3. Folder path templates.
4. Series hub notes (anchor + occurrence list).
5. Routing rules and the new-series prompt.
6. Rename listener for colocated recordings.
7. Migration command.

## Rejected alternatives

- **Series-to-folder map in plugin data.** Doesn't sync with the vault, invisible to the user, wrong after any move made outside Obsidian.
- **Title-based identity.** Titles change; ids don't. Title matching stays available only as an opt-in heuristic for grouping ad-hoc meetings that have no `recurring_event_id`.
- **Deep date sharding (`Meetings/2026/07/…`) as default.** Possible via templates, but burying notes two folders deep hurts more than it helps at typical volumes.

## Open questions

1. Hub note vs most-recent-note as the series anchor: hub is proposed as primary. Worth the extra file per series?
2. Should the "where should this series live?" prompt be on by default, or is that one popup too many?
3. Do 1:1s deserve first-class treatment (per-person folder keyed on the other attendee) instead of being a routing-rule example?
4. Ad-hoc meetings currently land in the base folder. Route them too (they have attendees only after enrichment), or leave them in an inbox folder to be moved by hand?

## Appendix: the nightshift-program meetings folder

The same flat-list pain exists in `elastic/nightshift-program/meetings/` (31 files and counting), minus the plugin. Suggested convention there:

- `meetings/<series-or-topic>/YYYY-MM-DD-<slug>.md`, e.g. `meetings/program-sync/2026-07-08-nightshift-program-sync.md`; one-offs in `meetings/<year>/` or a topical folder.
- Keep the filename date prefix; it's what `/status-update` uses for windowing, so the only skill change is globbing `meetings/**/*.md` instead of `meetings/*.md`.
- `/zoom-transcripts` gains a "which folder?" step (defaulting from the slug) instead of always writing to the root.
