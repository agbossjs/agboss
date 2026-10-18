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
- The Wiki is a separate git repo; its working copy is `../<repo>.wiki`, managed by
  `scripts/wiki.sh` (`pull`, `publish`, `seed`). Its ts blocks compile and its commands and links
  exist — `node scripts/check-docs.mjs --wiki ../<repo>.wiki` before publishing; CI runs it too.
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
tags vX.Y.Z              ← every npm release; GitHub Release with notes
```

- Work branches are created from `main` and merged back into `main` via PR (squash).
- Releases are tags on `main` (`vX.Y.Z`), not separate long-lived branches. A maintenance line
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

### 1. Declare the role and implement it

A **role** is the project's abstract class: what it approves and who may answer (`answeredBy` is
required — a forgotten value must not let a customer approve their own refund). Its implementation
`extends` it and has one method, `send`: post the question somewhere (the pause's `pauseId` is the
reply key and the idempotency key of the call) and say what happens — `ChannelOutcome.awaitReply()`
pauses the execution until the reply, `ChannelOutcome.decided(decision)` goes on at once. The
execution — its tenant, the project's context fields — comes through an injected `ExecutionContext`.

<!-- snippet-context
import { Injectable } from "agboss";
import { Text } from "agboss/dto";
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
import {
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  ExecutionContext,
  PauseAnswerer,
  type ChannelAsk,
} from "agboss";

@ChannelRole({
  name: "user-deletion-approval-channel",
  description: "Approves deleting a user",
  approves: DeleteUserInputDto, // the input of the tools it approves ([channel.wrong-tool] else)
  answeredBy: PauseAnswerer.Channel, // Slack authenticates who answers
})
export abstract class UserDeletionApprovalChannel extends ChannelOf<UserDeletionApprovalChannel> {}

@Channel({
  name: "slack-user-deletion-approval-channel",
  description: "Asks an admin in Slack",
  deps: [SlackClient, ExecutionContext],
})
export class SlackUserDeletionApprovalChannel extends UserDeletionApprovalChannel {
  constructor(
    private readonly slackClient: SlackClient,
    private readonly executionContext: ExecutionContext,
  ) {
    super();
  }

  async send(
    ask: ChannelAsk<UserDeletionApprovalChannel>,
  ): Promise<ChannelOutcome<UserDeletionApprovalChannel>> {
    const { userId } = ask.value.arguments; // typed by DeleteUserInputDto
    const tenant = this.executionContext.tenant.tenantId;
    await this.slackClient.post(`Delete user ${userId} (${tenant})?`, ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}
```

### 2. Name the role on the tool, list the implementation in the application

`@Tool({ channel })` (or `@McpTool`) names the role; every call of that tool asks the channel before
the tool runs. The implementation is channel transport — infrastructure — listed only in
`@Application({ providers })` (none → `[di.missing-implementation]`, two →
`[di.ambiguous-implementation]`, in a workflow's `providers` → `[di.infrastructure-in-workflow]`). A
tool may also name a concrete `@Channel` as is (`TerminalUserChannel`; `AutoApproveChannel` /
`AutoRejectChannel`, which decide at once, for tests and scripts).

<!-- snippet-context
import { Agent, Application, EmptyEnvironment, Tool, Workflow, WorkflowFinish, WorkflowStart, start, type ToolHandler } from "agboss";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { DeleteUserInputDto, SlackClient, SlackUserDeletionApprovalChannel, UserDeletionApprovalChannel } from "./channels.js";
export class UserDeletedDto {
  @Text() userId!: string;
}
// @snippet
@Agent({ name: "admin-agent", description: "Manages users", prompt: "Manage users.", model: "moonshotai/kimi-k2.6", tools: [DeleteUserTool] })
export class AdminAgent {}
@WorkflowStart({ name: "chat-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class ChatStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatFinish {}
@Workflow({
  name: "admin-workflow",
  version: "1.0.0",
  flow: [start(ChatStart).returns(WorkflowStartTextDto).toAgent(AdminAgent).toFinish(ChatFinish)],
  providers: [SlackClient],
})
export class AdminWorkflow {}
@Application({
  name: "admin-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AdminWorkflow],
  providers: [SlackUserDeletionApprovalChannel], // the role's one implementation
})
export class AdminApplication {}
-->

```typescript file=tools.ts
@Tool({
  name: "delete_user",
  description: "Deletes a user account.",
  input: DeleteUserInputDto,
  output: UserDeletedDto,
  channel: UserDeletionApprovalChannel, // calls wait for an approval through the role
})
export class DeleteUserTool implements ToolHandler<DeleteUserInputDto, UserDeletedDto> {
  run({ userId }: DeleteUserInputDto): Promise<UserDeletedDto> {
    return Promise.resolve({ userId }); // runs only once the call is approved
  }
}
```

### 3. Pass the Execution's Values and Execute

There is no untyped `metadata` option (#261): the tenant, the thread's owner and the project's own
context fields are passed as typed values, kept in the checkpoint (a resume runs on them) and read
by the channel through its `ExecutionContext` — the same for guardrails and every other component.

<!-- snippet-context
import type { App } from "agboss";
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

### 4. Resume the Run

After `awaitReply()` the paused run's result carries its `threadId`. Once the reply arrives
out-of-band (e.g., the admin clicks "Approve" in Slack), resume that thread with the decision, a
`ToolCallApprovalDecisionDto` validated on the way in. `agboss chat` asks in the terminal and resumes
by itself. (Resuming a pause by its `pauseId` and free-text replies come with #267 PR 2 and PR 3.)

<!-- snippet-context
import type { App } from "agboss";
import { ChatStart } from "./tools.js";
declare const app: App;
-->

```typescript
const paused = await app.execute(ChatStart, { text: "Delete user 123" });

await app.resume(paused.threadId, {
  approved: false,
  by: "admin@example.com",
  feedback: "Please double check the user ID, 123 belongs to the CEO.",
});

// Approve but override the arguments (bypassing the LLM)
await app.resume(paused.threadId, {
  approved: true,
  by: "admin@example.com",
  overrideArguments: { userId: "456" }, // Corrected argument!
});
```

### Important Concepts

- **Override Arguments**: If the user modifies the tool arguments during the approval step, returning `overrideArguments` in the decision will inject those modified arguments straight into the tool, bypassing the LLM.
- **Decided at once**: a rule-based channel ("up to $50 approve at once") returns `ChannelOutcome.decided(decision)` — the step goes on with no pause, the decision validated like a reply. No channel needs the application to resume itself, and nothing waits in memory for a person.
- **Timeouts and Rejections**: If a run should timeout, use an external cron job or scheduler to call `app.resume(threadId, { approved: false, by: "scheduler", feedback: "Timeout" })`.
- **Durable pauses**: by default paused runs live in memory (the built-in in-memory `PausedExecutionRepository` and checkpointer, #261) and are lost on restart — dev and tests only. In production list durable implementations in `@Application({ providers })`: a class that `extends PausedExecutionRepository` and a durable `BaseCheckpointSaver` — e.g. `SqlitePausedExecutionRepository` and `SqliteCheckpointSaver` (#265, `sqlitePath` in the environment).
- **Resume across deployments**: each pause stores the workflow version and config hash it paused under. Resuming it on an app with another config hash throws `IncompatibleResumeError` (naming both versions) unless the workflow accepts it: `WorkflowSettings.builder().onIncompatibleResume(({ paused }) => paused.workflowVersion === "1.0.0" ? "resume" : "reject")`. A rejected resume leaves the run paused.
