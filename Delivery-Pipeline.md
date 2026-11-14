# Delivery Pipeline — the conveyor

Humans routeTo _what_ and _how_ through short quizzes; agents write the code, in parallel.
Every ticket's stage is the `Status` field on the repo's GitHub Project board.

```mermaid
flowchart LR
  R[requirement] --> T[Triage<br/>triage skill]
  T --> B[Backlog<br/>spec-session skill]
  B --> P[In progress<br/>implement skill]
  P --> X[Test<br/>merged to dev]
  X -->|human accepts| D[Done]
```

| Stage           | Set by                    | What the ticket contains                                                                                                                                                                                                                                  |
| --------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Triage**      | `triage`                  | why · what it does · what it does NOT do · constraints · acceptance criteria AC1… (business terms) · triage log                                                                                                                                           |
| **Backlog**     | `spec-session`            | + spec · implementation plan (files, parallel?, dependencies) · every business **AC** proven: **automated** (→ tests) and **manual** (where / do / expect / not OK if) checks, with a coverage table AC → checks · test cases · wiki to update · spec log |
| **In progress** | `implement` (start)       | branch `<type>-<N>` from `dev`                                                                                                                                                                                                                            |
| **Test**        | `implement` (after merge) | PR merged to `dev` (`Refs #N`), handoff comment with the manual acceptance checklist                                                                                                                                                                      |
| **Done**        | **human only**            | accepted; the human closes the issue                                                                                                                                                                                                                      |

## Quizzes — built for parallel sessions

Triage and spec run in 4–6 terminals at once, so every question is answerable cold
(`.claude/skills/QUIZ.md`):

- asked with the `AskUserQuestion` tool, up to 4 per round;
- the question restates the **ticket**, an **example situation** and the **decision**;
- each option states its **price**: 👍 benefit · 👎 cost (time, money, complexity, risk);
- the recommended option comes first; decisions are written to the issue log after each round.

## Parallel implementation

`implement` builds waves from `Depends on` and `Files touched`: issues in a wave share no files and
have their dependencies merged, so they run in parallel — one git worktree + sub-agent per issue,
or one Claude Code on the web session per issue. A ticket a fresh worker cannot implement from the
issue alone is a spec defect and gets `blocked`.

## Hierarchy and blocking

- Large work: parent issue (`type:epic`) with sub-issues — `scripts/ticket.sh sub <parent> <child>`.
- Cannot proceed: label `blocked` + comment (known / blocking / needed); the stage stays.

## Tools

| Command                                  | Purpose                            |
| ---------------------------------------- | ---------------------------------- |
| `scripts/ticket.sh setup`                | create and configure the board     |
| `scripts/ticket.sh status <N> "<Stage>"` | move a ticket                      |
| `scripts/ticket.sh list "<Stage>"`       | tickets in a column                |
| `scripts/ticket.sh sub <parent> <child>` | sub-issue                          |
| `scripts/wiki.sh stage / check`          | a PR's Wiki pages (`wiki/`)        |
| `scripts/wiki.sh pull / publish`         | Wiki edits with no code change     |

## Documenting a change

A change that touches the public API, the DSL or the architecture documents it **in its own PR**.
The Wiki's pages for it live in the folder `wiki/` of the PR, flat `<Page>.md` files named like the
Wiki's pages, reviewed together with the code:

1. `scripts/wiki.sh stage Routers.md` copies the current shared version of a page into `wiki/` (a new
   page: create `wiki/<Page>.md`); edit it there.
2. `scripts/wiki.sh check` is what CI runs: the shared Wiki plus your pages, every ts block
   compiled, every command and link checked. A page that does not compile fails only your PR.
3. Commit `wiki/` with the code. Open the PR; the PR template has a "Wiki pages" section.
4. After the merge there is nothing to do. When `main`'s CI has passed, **Sync Wiki** writes the
   pages to the Wiki and to the branch `docs/wiki-pending`, exactly once (a commit trailer
   `Wiki-Overlay-Source: <main sha>` marks how far it got). `wiki/` is not emptied: only the files a
   PR changes count, so a stale copy there is never published again.

Why not push the Wiki first: the CI of **every** PR compiles the shared Wiki (`docs/wiki-pending`)
against its own code. A page for an unmerged change on that branch breaks every other PR, so the
branch only ever holds pages for code that is on `main`. Two PRs that edit one page conflict in
git at the merge, and the second is rebased. Deleting or renaming a page is not done through a PR:
`scripts/wiki.sh publish` after the merge. Wiki edits with no code change (typos, ADR notes) go the
same way.

## Promotion

`dev → staging → production` by PR, as a release step — never by an agent.
