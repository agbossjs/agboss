---
name: implement
description: Conveyor stage 3 → status In progress, and Test after merge. Implements Backlog issues — in parallel where they are independent (git worktrees with sub-agents, or separate Claude Code on the web sessions), in dependency order otherwise — each as its own branch and PR into main with tests, green gate, self-review, Wiki update and a manual-test handoff. Never moves anything to Done. Use after spec-session, or when the user says "implement", "имплементируй", "запусти", "go", or names Backlog issues to build.
---

# implement

Conveyor: Triage → Backlog → **In progress** → **Test** → Done (Done: human only).
The issue (body + comments) is the only source of the spec and the plan.

## Input

Issue numbers, or everything in Backlog: `scripts/ticket.sh list Backlog` (skip `blocked`).

## 1. Plan waves

Build the dependency graph from `Depends on` and `Files touched`:

- a **wave** = issues whose dependencies are merged and which share no files with each other;
- waves run one after another; issues inside a wave run in parallel.

Tell the user the waves before starting.

## 2. Run a wave in parallel

Each issue gets an isolated workspace and a worker that knows only the issue number and
section 3 below:

- **locally**: `git worktree add ../<repo>-<type>-<N> -b <type>/<N>-<slug> origin/main`, one
  sub-agent per worktree;
- **or in the cloud**: one Claude Code on the web session per issue, same procedure.

An issue that is not self-sufficient for a fresh worker is a spec defect: label it `blocked`,
comment what is missing, and continue with the rest.

## 3. Per issue

1. `scripts/ticket.sh status <N> "In progress"`.
2. Read `gh issue view <N> --comments` and the code it touches.
3. **Tests first**: every automated acceptance criterion and test case → a failing test; each test
   name or describe block carries its AC id (`AC2: …`) so coverage stays traceable.
4. Implement until green; follow the plan, note deviations for the PR.
5. **Gate**: `make check`. Never lower thresholds, disable rules or add ignores. The same failure
   twice after a real fix attempt → label `blocked`, comment, stop this issue.
6. **Self-review** `git diff origin/main...HEAD` against `QUALITY.md`.
7. **Changelog fragment**: a user-visible change adds `changes/<issue>-<slug>.md` (header
   `section:` + `issue:`, then the entry mentioning `#<N>`; see `changes/README.md`). Never edit
   `CHANGELOG.md` — CI fails it outside a `release/*` branch.
8. **PR** — body via stdin per `.github/pull_request_template.md`, with `Refs #<N>`
   (**not** `Closes`: the issue stays open until a human accepts it):
   `gh pr create --base main --title "<type>-<N>: <title>" --body-file -`
9. **Merge** after CI: `gh pr checks --watch && gh pr merge --squash --delete-branch`.
   A conflict with something merged earlier in the wave → rebase on `origin/main`, gate again;
   if it is not mechanical → `blocked` + comment, do not guess.
10. **Wiki**: apply "Wiki to update" in `../<repo>.wiki`, then
    `scripts/wiki.sh publish "docs(#<N>): <what changed>"`.
11. `scripts/ticket.sh status <N> Test`, then a handoff comment on the issue:
    - what was done, PR link, deviations;
    - **Acceptance by AC** — for every business AC: the automated tests that prove it (passed)
      and the manual checks (`M1 (AC1)` …) as a checklist the human can follow as-is;
    - "Move to Done and close the issue when accepted."

## 4. Finish

After the last wave: a summary to the user (and on the parent issue, if any) — in Test, blocked
with reasons, not started. Never move an issue to Done and never close issues.
