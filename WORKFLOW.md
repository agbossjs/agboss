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

The `@Channel` decorator provides a unified way to handle human-in-the-loop and out-of-band tool call approvals. It decouples the workflow's business logic from the specific mechanism (CLI, Slack, Webhooks, gRPC) used to obtain the approval.

### 1. Define a Channel

A channel is a class that implements `ChannelHandler`: `requestApproval(req)` is called once each
time a run pauses at one of its tools (`req`: `runId`, `agentName`, `toolName`, `toolArguments`,
`metadata`). The container creates it, so it takes `deps` like a tool. An optional `inboundAdapter`
(`@InboundChannelAdapter`) turns the reply your channel receives (a button click, a webhook body)
into the decision.

<!-- snippet-context
import { Injectable } from "agboss";
@Injectable()
export class SlackClient {
  post(_text: string): Promise<void> {
    return Promise.resolve();
  }
}
-->

```typescript file=channels.ts
import { Channel, InboundChannelAdapter, type ChannelHandler, type ChannelRequest } from "agboss";

@InboundChannelAdapter({ name: "slack-click" })
export class SlackClick implements InboundChannelAdapter<{ action: string; user: string }> {
  interpret(click: { action: string; user: string }) {
    return Promise.resolve({ approved: click.action === "approve", by: click.user });
  }
}

@Channel({ name: "slack_approval", inboundAdapter: SlackClick, deps: [SlackClient] })
export class SlackChannel implements ChannelHandler {
  constructor(private readonly slack: SlackClient) {}

  requestApproval = (req: ChannelRequest): Promise<void> =>
    this.slack.post(`Approve ${req.toolName} for run ${req.runId}?`);
}
```

### 2. Attach the Channel to a Tool

Set `channel` on `@Tool` / `@McpTool` to the channel class, and list the class in
`@Workflow({ channelClasses })`. Every call of that tool pauses the run before the tool runs.

<!-- snippet-context
import { Agent, Tool, Workflow, WorkflowFinish, WorkflowStart, start, type ToolHandler } from "agboss";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { SlackChannel } from "./channels.js";
class DeleteUser {
  @Text() userId!: string;
}
class Deleted {
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
  channelClasses: [SlackChannel],
})
export class AdminWorkflow {}
-->

```typescript file=tools.ts
@Tool({
  name: "delete_user",
  description: "Deletes a user account.",
  input: DeleteUser,
  output: Deleted,
  channel: SlackChannel, // calls wait for an approval through SlackChannel
})
export class DeleteUserTool implements ToolHandler<DeleteUser, Deleted> {
  run({ userId }: DeleteUser): Promise<Deleted> {
    return Promise.resolve({ userId }); // runs only once the call is approved
  }
}
```

### 3. Provide Metadata and Execute

When starting the graph, you can pass string context (like user ID, tenant, etc.) using the `metadata` parameter. This metadata is passed to the `requestApproval` method of your channel (its resume keeps it); tools do not see it — `ExecutionContext` carries no metadata (#280), domain data come through a node's `input`.

<!-- snippet-context
import type { App } from "agboss";
import { ChatStart } from "./tools.js";
declare const app: App;
-->

```typescript
const result = await app.execute(
  ChatStart,
  { text: "Delete user 123" },
  { metadata: { approverEmail: "admin@example.com" } },
);
```

### 4. Resume the Run

The paused run's result carries its `threadId`. Once the reply arrives out-of-band (e.g., the user
clicks "Approve" in Slack), resume that thread with it. With an `inboundAdapter`, pass the raw reply
and the adapter turns it into the decision; without one, pass a `ChannelDecision`. `agboss chat` asks in
the terminal and resumes by itself.

<!-- snippet-context
import type { App } from "agboss";
import { ChatStart } from "./tools.js";
declare const app: App;
-->

```typescript
const paused = await app.execute(ChatStart, { text: "Delete user 123" });

// Through the channel's adapter: the raw reply
await app.resume(paused.threadId, { action: "approve", user: "admin@example.com" });

// Without an adapter: the decision itself
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
- **Timeouts and Rejections**: Channels are asynchronous fire-and-forget mechanisms. If a run should timeout, use an external cron job or scheduler to call `app.resume(threadId, { approved: false, by: "scheduler", feedback: "Timeout" })`.
- **Durable pauses**: by default paused runs live in memory (the built-in in-memory `PausedExecutionRepository` and checkpointer, #261) and are lost on restart — dev and tests only. In production list durable implementations in `@Application({ providers })`: a class that `extends PausedExecutionRepository` and a durable `BaseCheckpointSaver` — e.g. `SqlitePausedExecutionRepository` and `SqliteCheckpointSaver` (#265, `sqlitePath` in the environment).
- **Resume across deployments**: each pause stores the workflow version and config hash it paused under. Resuming it on an app with another config hash throws `IncompatibleResumeError` (naming both versions) unless the workflow accepts it: `WorkflowSettings.builder().onIncompatibleResume(({ paused }) => paused.workflowVersion === "1.0.0" ? "resume" : "reject")`. A rejected resume leaves the run paused.
