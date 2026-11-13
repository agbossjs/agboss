# Changelog fragments

A pull request never edits `CHANGELOG.md` (CI fails it). It adds one file here instead, so two PRs
never conflict on the changelog (#981). At release, `scripts/changelog-assemble.mjs` folds the
fragments into the version's section of `CHANGELOG.md` and deletes them.

## The rule

- Path: `changes/<issue>-<slug>.md`. The issue is the one the PR `Refs`; the slug is lowercase
  words joined by hyphens, so one issue with two entries uses two slugs.
- A header of two keys, then the entry text. `section` is one of `Breaking`, `Changed`, `Added`,
  `Fixed`, `Deprecated`, `Security`; `issue` equals the number in the file name.
- The entry is Markdown, written as it should read in `CHANGELOG.md` (a bold lead, the reason, the
  migration for a breaking change). It must mention `#<issue>`. Continuation lines are indented by
  the script, so write them flush left.
- Delete nothing under `CHANGELOG.md`; existing entries stay as they are.

```markdown
---
section: Fixed
issue: 960
---

**A task status has one rule at every nesting level** (#960): the sweep read the status of a
nested task by a different rule than the top level did. No migration.
```

## Assembling (the release PR)

```sh
node scripts/changelog-assemble.mjs 0.1.2 --date 2026-12-01
```

Sections come out in the order Breaking (headed `Changed — breaking`), Changed, Added, Fixed,
Deprecated, Security; inside a section by issue number. A fragment with an unknown section, a name
that disagrees with its `issue`, or an entry that does not mention its issue fails the run and
changes nothing. With no fragments the run does nothing, so it is safe to repeat. `--check`
validates the fragments without assembling.

## The release PR

A PR may edit `CHANGELOG.md` only from a branch named `release/<version>`. Every other PR that
touches `CHANGELOG.md` fails the `changelog-fragments` CI job with a pointer here.
