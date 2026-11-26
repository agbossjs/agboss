# WORKFLOW

How work moves from a requirement to accepted code.

## Where things live — no specs, plans or docs as files in the repo

| Kind of knowledge                                       | Place                                        |
| ------------------------------------------------------- | -------------------------------------------- |
| Work items, discussion, **specs, implementation plans** | GitHub Issues of this repo (body + comments) |
| **Stage of every ticket**                               | its `status:*` label (`scripts/ticket.sh`)   |
| How the system works now                                | **GitHub Wiki** of this repo                 |
| Why a significant decision was made                     | Wiki pages `ADR-NNNN-Title`                  |
| Rules                                                   | `QUALITY.md`, `WORKFLOW.md`, `CLAUDE.md`     |

- Issue and PR bodies are passed to `gh` via stdin (`--body-file -`), never through files.
- The Wiki is a separate git repo; scripts/wiki.sh manages it (`stage`, `check`, `pull`, `publish`,
  `seed`). Its ts blocks compile and its commands and links exist; CI runs `check-docs.mjs --wiki`.
- A change's Wiki pages travel in its PR (#1026), in the folder `wiki/` (flat `<Page>.md` files;
  `scripts/wiki.sh stage <Page.md>` copies the shared version to edit, `scripts/wiki.sh check` is
  the CI check). CI checks the shared Wiki — `docs/wiki-pending`, else the published Wiki — plus
  that PR's own pages and nothing else, so a PR's pages never reach another PR's check. Nothing is
  pushed to `docs/wiki-pending` or the Wiki before the merge: that branch holds only pages for code
  that is on main. When main's CI has passed, `.github/workflows/sync-wiki.yml` runs
  `scripts/wiki-sync.sh`: each merged PR's pages become a Wiki commit (trailer
  `Wiki-Overlay-Source: <main sha>` = published up to here, so exactly once; `wiki/` is never
  emptied) and `docs/wiki-pending` is fast-forwarded to it (fast-forward only; a page edited in the
  Wiki's web UI and missing from the branch stops the sync instead of being lost). Two PRs on one
  page conflict in git. Edits with no code change: `scripts/wiki.sh publish`.
- Stages are managed by `scripts/ticket.sh` (`setup`, `status`, `list`, `sub`), with repository REST
  endpoints only — cloud sessions cannot reach GraphQL or the Projects board (#283).

## The conveyor

| Stage (`status:*`) | Set by                          | Means                                                                                               |
| ------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Triage**         | `triage` skill                  | business side clarified: why, what it does, what it does not, constraints, acceptance criteria AC1… |
| **Backlog**        | `spec-session` skill            | spec, implementation plan, tests and manual checks mapped to every business AC                      |
| **In progress**    | `implement` skill (start)       | branch exists, work under way                                                                       |
| **Test**           | `implement` skill (after merge) | merged to `main`, manual acceptance instructions posted on the issue                                |
| **Done**           | **a human only**                | accepted; the human also closes the issue                                                           |

- Every skill moves the ticket to its own stage when it finishes.
- Triage and spec are **quiz-driven** (`.claude/skills/QUIZ.md`) and run in parallel sessions:
  every question restates the ticket, an example situation and the price of each option.
- Implementation runs independent tickets in parallel (worktrees + sub-agents, or Claude Code on
  the web), dependent ones in order.
- A ticket that cannot proceed gets the label `blocked` and a comment (what is known, what blocks,
  what is needed); its stage does not change.
- Large work: a parent issue (`type:epic`) with sub-issues (`scripts/ticket.sh sub`).

## Labels

`type:feature` · `type:bugfix` · `type:chore` · `type:epic` · `prio:mvp` · `prio:stretch` ·
`blocked` · stages: `status:triage` · `status:backlog` · `status:in-progress` · `status:test`
(one per issue; Done has no label — a human closes the issue).

## Branch model

Typical OSS layout (reference: [graphify](https://github.com/safishamsi/graphify)), adopted with
the AGBoss rebrand (#167):

```
main                     ← default; always releasable; PR target
feat/<issue>-<slug>      ← e.g. feat/182-typed-environments
fix/<issue>-<slug>       ← e.g. fix/186-batch-parallel
chore/<issue>-<slug>     ← e.g. chore/167-rebrand-agboss
docs/<issue>-<slug>
spike/<issue>-<slug>     ← experiments, never merged as is
v1, v2 …                 ← maintenance lines, created only when a major ships
tags vX.Y.Z              ← every npm release (.github/workflows/release.yml publishes it, #691); GitHub Release with notes
```

- Work branches are created from `main` and merged back into `main` via PR (squash).
- Releases are tags on `main` (`vX.Y.Z`), not separate long-lived branches. Only the maintainer pushes
  one; the release workflow publishes it once CI passed on that commit (`RELEASE_CHECKLIST.md`). A maintenance line
  (`v1`, `v2`, …) is cut only once a major version ships and needs backports.
- Nobody pushes directly to `main`.
- Pre-OSS history: the old `staging`/`production` branches are archived as tags
  `pre-oss-staging` / `pre-oss-production` and the branches themselves deleted — their commits stay
  reachable through the tag, not through a live branch.
- Branches created before this change (`bugfix-183`, `feature-182`, …) keep their old name until
  merged; the naming below applies to branches created after it.

## Branch naming

`<type>/<issue>-<slug>` — e.g. `feat/182-typed-environments`, `fix/186-batch-parallel`,
`chore/167-rebrand-agboss`, `docs/201-readme-examples`, `spike/115-request-fingerprint`. The slug
is a short, readable hint, not a restatement of the issue title.

## Commits

Conventional commits with the issue number: `feat(#12): …`, `fix(#13): …`, `test(#12): …`,
`chore(#14): …`. Small commits are fine; the PR is squash-merged.

## Pull requests

- Base: `main`. Title: `<type>-<issue>: <issue title>`.
- Body follows `.github/pull_request_template.md` and says **`Refs #<issue>`** — never `Closes`:
  merging must not close the issue, because acceptance happens in Test.
- One PR per issue. No drive-by changes outside the issue scope — open a new issue instead.
- Merge: squash, delete branch, after `make check` / CI is green.

## Definition of Done (for the agent: ready for Test)

- [ ] Every business acceptance criterion (AC) is proven by a passing test or a manual check
- [ ] All automated acceptance criteria are tests, and they pass
- [ ] `make check` green (types, lint, format, coverage ≥ 80%)
- [ ] Self-review against `QUALITY.md` done
- [ ] "Wiki to update" applied and published (ADR page if a significant decision was made)
- [ ] PR merged to `main`; ticket moved to **Test**; handoff comment with the manual acceptance
      checklist posted on the issue
- [ ] **Crucial Rule:** The GitHub CI must pass successfully (green) before starting any work on the next ticket. We do not accumulate CI problems or technical debt.

**Done** is the human's call after the manual checklist passes.

## Tool Call Approvals (Channels)

A tool that needs a decision before it runs names a **channel** (#267). Channels are found through
the tools that name them — there is nothing to list in the workflow — and are created once per
application, shared by all its workflows.

### 1. Declare the target and its channel

A **target** (`@ToolApproval`, or `@ExternalTask` for a question) says what is asked and who may answer
(`respondent` is required — a forgotten value must not let a customer approve their own refund) and
how long the pause waits (`timeout`). A **channel** carries it to the people: `@Channel({ target, ttl })`,
a class with one method, `send`: post the question somewhere (the pause's `pauseId` is the
reply key and the idempotency key of the call) and say what happens — `ChannelOutcome.awaitReply()`
pauses the execution until the reply, `ChannelOutcome.decided(decision)` goes on at once. The
execution — its tenant, the project's context fields — comes through an injected `ExecutionContext`.

<!-- snippet-context
import { Injectable } from "@agboss/core";
import { Text } from "@agboss/core/dto";
@Injectable()
export class SlackClient {
  post(_text: string, _replyKey: string): Promise<void> {
    return Promise.resolve();
  }
}
export class DeleteUserInputDto {
  @Text() userId!: string;
}
-->

```typescript file=channels.ts
import { Channel, ChannelOutcome, ExecutionContext, PauseRespondent, type ChannelAsk, ToolApproval } from "@agboss/core";
import { hours } from "@agboss/core/units";

@ToolApproval({
  name: "user-deletion-tool-approval",
  description: "Approves deleting a user",
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class UserDeletionToolApproval {}

@Channel({
  name: "slack-user-deletion-approval-channel",
  description: "Asks an admin in Slack",
  deps: [SlackClient, ExecutionContext],
  target: UserDeletionToolApproval, ttl: hours(1),
})
export class SlackUserDeletionApprovalChannel {
  constructor(
    private readonly slackClient: SlackClient,
    private readonly executionContext: ExecutionContext,
  ) {
  }

  async send(
    ask: ChannelAsk<UserDeletionToolApproval>,
  ): Promise<ChannelOutcome<UserDeletionToolApproval>> {
    const { userId } = ask.input; // typed by DeleteUserInputDto
    const tenant = this.executionContext.tenant.tenantId;
    await this.slackClient.post(`Delete user ${userId} (${tenant})?`, ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}
```

### 2. Name the target on the tool, list the channel in the application

`@Tool({ approval })` names the target; every call of that tool asks the channel before
the tool runs. The channel is transport — infrastructure — listed only in
`@Application({ channels })` (one target with several channels names a `@ChannelSelector({ target })`
that picks one; a `Delegate` target with no channel is refused at assembly). In tests
`AutoApproveChannel.for(Target)` / `AutoRejectChannel.for(Target)` from `@agboss/core/testing` decide at
once; an approval the thread's owner answers needs no channel at
all (`@ToolApproval({ respondent: PauseRespondent.Owner })`, answered by `app.resume`).

<!-- snippet-context
import { Agent, Application, Tool, Workflow, WorkflowFinish, WorkflowStart, onStart, inline, Ttl } from "@agboss/core";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
import { DeleteUserInputDto, SlackClient, SlackUserDeletionApprovalChannel, UserDeletionToolApproval } from "./channels.js";
export class UserDeletedDto {
  @Text() userId!: string;
}
// @snippet
@Agent({ name: "admin-agent", description: "Manages users", prompt: inline("Manage users."), model: "moonshotai/kimi-k2.6", tools: [DeleteUserTool] })
export class AdminAgent {}
@WorkflowStart({ name: "chat-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class ChatStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatFinish {}
@Workflow({
  name: "admin-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart).toAgent(AdminAgent).toFinish(ChatFinish)],
  providers: [SlackClient],
})
export class AdminWorkflow {}
@Application({
  name: "admin-application",
  version: "1.0.0",
  workflows: [AdminWorkflow],
  channels: [SlackUserDeletionApprovalChannel], // the target's channel
})
export class AdminApplication {}
-->

```typescript file=tools.ts
@Tool({
  name: "delete-user-tool",
  description: "Deletes a user account.",
  input: DeleteUserInputDto,
  output: UserDeletedDto,
  approval: UserDeletionToolApproval, // calls wait for an approval of the target
})
export class DeleteUserTool {
  execute({ userId }: DeleteUserInputDto): Promise<UserDeletedDto> {
    return Promise.resolve({ userId }); // runs only once the call is approved
  }
}
```

### 3. Pass the Execution's Values and Execute

There is no untyped `metadata` option (#261): the tenant, the thread's owner and the project's own
context fields are passed as typed values, kept in the checkpoint (a resume runs on them) and read
by the channel through its `ExecutionContext` — the same for guardrails and every other component.

<!-- snippet-context
import type { App } from "@agboss/core";
import { ChatStart } from "./tools.js";
declare const app: App;
-->

```typescript
const result = await app.execute(
  ChatStart,
  { text: "Delete user 123" },
  { tenant: { tenantId: "acme" }, ownerId: "admin@example.com" },
);
```

### 4. Answer the Pause

After `awaitReply()` the run rests paused. Once the reply arrives out-of-band (e.g., the admin clicks
"Approve" in Slack), answer that pause **by its id** — the `pauseId` the channel was sent (the
reply key of its message) — with the decision, a `ToolCallApprovalDecisionDto` validated on the way
in. The target says who may answer: this one is `PauseRespondent.Delegate`, so Slack's side names who
answered (`actor`, recorded on the pause and in `onExecutionResume`); its id never appears in
`result.pending`. A `PauseRespondent.Owner` pause is answered with the thread's `ownerId`
instead, its id listed in `result.pending`. `agboss chat` asks in the terminal and answers by
itself. (Free-text replies come with #267 PR 3.)

<!-- snippet-context
import type { App } from "@agboss/core";
declare const app: App;
declare const replyKey: string;
-->

```typescript
// the Slack webhook: the reply key of the message is the pause's id
await app.resume(
  { pauseId: replyKey, decision: { approved: false, reason: "123 belongs to the CEO" } },
  { tenantId: "acme", actor: { id: "admin@example.com" } },
);

// approve, but with corrected arguments (bypassing the LLM)
await app.resume(
  { pauseId: replyKey, decision: { approved: true, overrideInput: { userId: "456" } } },
  { tenantId: "acme", actor: { id: "admin@example.com" } },
);
```

### Important Concepts

- **Override Arguments**: If the user modifies the tool arguments during the approval step, returning `overrideInput` in the decision will inject those modified arguments straight into the tool, bypassing the LLM — only with `approved: true`, and checked against the tool's input DTO (`ValidationError.DtoInvalid` otherwise; the pause keeps waiting).
- **Several pauses at once**: parallel branches each pause on their own; the execution rests only when nothing else can move, `result.pending` lists every waiting pause, and answering one continues it while the others keep waiting. Two answers to one pause (a double click) — the second gets `PauseError.Closed`.
- **Decided at once**: a rule-based channel ("up to $50 approve at once") returns `ChannelOutcome.decided(decision)` — the step goes on with no pause, the decision validated like a reply. No channel needs the application to resume itself, and nothing waits in memory for a person.
- **Timeouts and Rejections**: a pause has a deadline — the target's `timeout` — and an expiry rule (`PauseExpiration`: decide, fail, or reassign); the framework expires it, no external cron job needed. A person who must refuse answers `app.resume({ pauseId, decision: { approved: false, reason: "Timeout" } }, { tenantId, actor: { id: "scheduler" } })`.
- **Durable pauses**: each pause is a record of `PausedExecutionRepository`, made by its step's idempotency key before the channel is asked, so a retried `send` carries the same `pauseId`. By default paused runs live in memory (the built-in in-memory storage, `InMemoryDatabaseStorage`) and are lost on restart — dev and tests only. In production name a durable `@DatabaseStorage` in `@Application({ storage })`: its driver (`SqliteDriver({ path })`, or the PostgreSQL / MongoDB one) holds the pauses, the checkpoints and every other store (#265, #1321).
- **Resume across deployments**: each pause stores the workflow version and config hash it paused under. Resuming it on an app with another config hash throws `ExecutionError.IncompatibleResume` (naming both versions) unless the workflow accepts it: `WorkflowSettings.builder().onIncompatibleResume(({ paused }) => paused.workflowVersion === "1.0.0" ? "resume" : "reject")`. A rejected resume leaves the run paused.
