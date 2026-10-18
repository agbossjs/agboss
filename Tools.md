# Tools

A tool is a `@Tool` class in its workflow's `tools/` folder — see [Components](Components) for the
pattern (constructor dependencies, `ToolHandler`, tests with `new`).

<!-- snippet-context
import { InjectionToken } from "agboss";
interface IssuesApi { search(query: string, signal: AbortSignal): Promise<IssueList> }
const ISSUES_API = new InjectionToken<IssuesApi>("ISSUES_API");
-->

```ts
import { ExecutionContext, Tool, type ToolHandler } from "agboss";
import { ListOf, Text } from "agboss/dto";

export class Issue {
  @Text() title!: string;
  @Text() url!: string;
}

export class IssueQuery {
  @Text({ prompt: "words to search the issues for" })
  query!: string;
}

export class IssueList {
  @ListOf(Issue)
  issues!: Issue[];
}

@Tool({
  name: "search_issues",
  description: "Search the team's issues",
  input: IssueQuery,
  output: IssueList,
  timeoutMs: 10_000,
  deps: [ExecutionContext, ISSUES_API],
})
export class SearchIssues implements ToolHandler<IssueQuery, IssueList> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly issuesApi: IssuesApi,
  ) {}

  run({ query }: IssueQuery): Promise<IssueList> {
    return this.issuesApi.search(query, this.executionContext.signal);
  }
}
```

Input and output are DTO classes ([Components → DTOs](Components#dtos)); the model sees the input DTO's
JSON Schema, with each field's `prompt` as its description.

## Contract

| Step of `tool.invoke(raw)`                         | On failure                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| input validated against the input DTO             | `error: invalid input: <path>: <issue>` (`jobs[2].url`) — `run` is not called |
| run is not started if the run is already cancelled | `error: <abort reason>`                                       |
| `run` under a timeout and the run's `AbortSignal`  | `error: timed out after N ms` / `error: <message>`            |
| output validated against the output DTO           | `error: invalid output: …` — a contract bug of the tool       |

Results are values — `ToolResult = { kind: "ok", value } | { kind: "error", message }` — never
exceptions: the model sees `Tool error: …` and can recover.

`run` gets only its input (#280 — there is no `ToolContext`). The execution it runs in comes through
the constructor: `deps: [ExecutionContext]` gives `executionId`, `threadId`, `ownerId`, `signal`,
`workflow` and the call's `step` (`callId`, `idempotencyKey`, …)
([Context and Authorization](Context-And-Authorization)). A tool's model spend through
`ROUTER_FACTORY` is recorded as the tool's; what it pays a service that is not a model it records
with `deps: [SpendRecorder]` — `this.spendRecorder.record({ service, cost: usd(…) })`, counted in
the money limits ([FinOps](FinOps)).

## Library and workflow tools

A tool lives in its workflow's `tools/` folder (the framework ships none). There is no central
registry: an agent's `tools: [SearchIssues]` **is** the registration.

## MCP

A server declares the tools it offers that the workflow uses (`@McpServer({ tools })`, `extends McpServerClient`);
an `@McpTool` is a tool with that server injected, calling it in `run` — see
[Components → MCP](Components#mcp). Env variable NAMES only in the config, never secrets.
A server tool that answers with plain text declares `output: PlainTextDto` (`agboss/dto`, the one
field `text`) — the server's text arrives as `{ text }`; `agboss g mcp` writes that by default.

## Agents with tools

<!-- snippet-context
import { Agent } from "agboss";
declare class GreenhouseJobs { run(input: object): Promise<object> }
-->

```ts
// agents/scout.agent.ts — the workflow sets defaults.tools.maxToolCalls; an agent may override it
@Agent({
  name: "scout",
  description: "Finds jobs",
  promptUrls: ["./scout.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  tools: [GreenhouseJobs],
  maxToolCalls: 4,
})
export class Scout {}
```

- `tools` lists classes — a missing or not-imported tool does not compile; at startup names are
  re-checked against the registry (`UnknownAgentToolError`).
- The agent runs the framework's own loop ([Agents](Agents)): usage recorded per model call, the
  execution's budgets checked before each call (one exhausted → `BudgetExceededError`), `maxToolCalls` → `agents.<name>.limits.toolCalls` (default 20) **fails
  the run** with `LimitExceededError`; the loop's spend still reaches the budgets' counters.
- Each call runs as its own task with its own signal; parallel calls of one turn run concurrently.
  In the call, `executionContext.signal` is the call's (#280 S45): the execution's signal (cancel
  included) combined with a timer of the tool's `timeoutMs`, cleared when the call ends — so
  `fetch(url, { signal: this.executionContext.signal })` stops on a cancel and on the call's own
  timeout, while the execution goes on (the model reads `Tool error: timed out after N ms`).
- `executionContext.step.callId` is the call's id — the same when a call interrupted by a crash
  runs again — and `executionContext.step.idempotencyKey`
  (`${executionId}:${nodeId}:${visitNumber}[:${itemIndex}]:${callId}`) the key a tool with side
  effects **must** pass to the external service.
- Tool errors do not fail the run: the model reads `Tool error: …` and continues.

## For the model

`toolDefinitionOf(tool)` describes a tool to the agent's chat model (`bindTools`): name, description
and the JSON Schema of the input; validation, timeout and error mapping stay in `invoke`.

## Isolation and tests

`src/tools` imports only `config`, `finops`, `llm`; the rest of the code imports it only through
`src/tools/index.ts` (ESLint) — inside the framework; tool tests run without network.

Decisions: [ADR-0003](ADR-0003-Typed-tools-and-MCP-facades).

## Who can use which tool

An agent's `tools` lists **class references**, so a missing or not-imported tool is a compile error.
To see it all at once — no API key or network needed:

```bash
npm run describe
```

```
  notes  moonshotai/kimi-k2.6 · thinking default · history 5 turns + 10 summaries
    · note_search (read, local) ← NOTES_FILE — Find the user's saved notes …
    · note_save (write, local, waits for approval) ← NOTES_FILE — Save a note for the user.
unassigned tools: none
```


## Approval channels

A tool that needs a decision before it runs names a channel: `@Tool({ channel })` (or `@McpTool`).
Channels are found through the tools that name them, like services through `deps` — there is no
`channelClasses` (#267) — and one instance serves every workflow of the application. A tool names
either a concrete `@Channel` as is (`TerminalUserChannel`, `AutoApproveChannel`,
`AutoRejectChannel`) or a **channel role** — the project's abstract class that says what it approves
and who may answer:

<!-- snippet-context
import { Agent, Application, EmptyEnvironment, Injectable, Workflow, WorkflowFinish, WorkflowStart, start } from "agboss";
import { Integer, Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
export class RefundCardInputDto {
  @Text() orderId!: string;
  @Integer({ min: 1 }) amountCents!: number;
}
export class RefundCardOutputDto {
  @Text() status!: string;
}
@Injectable()
export class SlackService {
  post(_channel: string, _text: string, _replyKey: string): Promise<void> {
    return Promise.resolve();
  }
}
// @snippet
@Agent({ name: "refund-agent", description: "Refunds", prompt: "Refund.", model: "moonshotai/kimi-k2.6", tools: [RefundCardTool] })
export class RefundAgent {}
@WorkflowStart({ name: "refund-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class RefundWorkflowStart {}
@WorkflowFinish({ name: "refund-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class RefundWorkflowFinish {}
@Workflow({
  name: "refund-workflow",
  version: "1.0.0",
  flow: [start(RefundWorkflowStart).returns(WorkflowStartTextDto).toAgent(RefundAgent).toFinish(RefundWorkflowFinish)],
  providers: [SlackService],
})
export class RefundWorkflow {}
@Application({
  name: "refund-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RefundWorkflow],
  providers: [SlackRefundApprovalChannel], // the role's one implementation: channel transport
})
export class RefundApplication {}
-->

```ts file=refunds.ts
import {
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  ExecutionContext,
  PauseAnswerer,
  Tool,
  type ChannelAsk,
  type ToolHandler,
} from "agboss";

// channels/refund-approval.channel.ts — the role: what it approves, who answers
@ChannelRole({
  name: "refund-approval-channel",
  description: "Approves card refunds",
  approves: RefundCardInputDto, // the tools' input DTO — imports go DTO ← role ← tool
  answeredBy: PauseAnswerer.Channel,
})
export abstract class RefundApprovalChannel extends ChannelOf<RefundApprovalChannel> {}

// channels/slack-refund-approval.channel.ts — its implementation, listed in the application
@Channel({
  name: "slack-refund-approval-channel",
  description: "Asks a finance manager in Slack",
  deps: [ExecutionContext, SlackService],
})
export class SlackRefundApprovalChannel extends RefundApprovalChannel {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly slackService: SlackService,
  ) {
    super();
  }

  async send(ask: ChannelAsk<RefundApprovalChannel>): Promise<ChannelOutcome<RefundApprovalChannel>> {
    const cents: number = ask.value.arguments.amountCents; // typed by RefundCardInputDto
    const tenant = this.executionContext.tenant.tenantId;
    await this.slackService.post("#finance", `Refund ${String(cents)}¢ (${tenant})?`, ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}

// tools/refund-card.tool.ts — the tool names the role
@Tool({
  name: "refund_card",
  description: "Refunds a card payment",
  input: RefundCardInputDto,
  output: RefundCardOutputDto,
  channel: RefundApprovalChannel,
})
export class RefundCardTool implements ToolHandler<RefundCardInputDto, RefundCardOutputDto> {
  run({ orderId }: RefundCardInputDto): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}
```

- **`@ChannelRole({ name, description, answeredBy, approves | ask + answer, replyInterpreter? })`**
  — two forms, never both (`[channel.role-form]`): `approves: XDto` for a tool approval (the
  question is `ToolCallApprovalAskDto` with `arguments: XDto`, the answer
  `ToolCallApprovalDecisionDto` with `overrideArguments?: XDto`), or `ask` / `answer` for a workflow
  question. `answeredBy` is required — `PauseAnswerer.ThreadOwner` or `PauseAnswerer.Channel`, no
  default. A tool whose `input` is not its role's `approves` (or that names a question role) fails
  assembly with `[channel.wrong-tool]`; one `replyInterpreter` class in two roles with
  `[channel.shared-interpreter]`.
- **The implementation** is a `@Channel` that `extends` the role, listed in
  `@Application({ providers })` — found by inheritance, like any contract: none →
  `[di.missing-implementation]`, two → `[di.ambiguous-implementation]`; a `@Channel` in a workflow's
  `providers` → `[di.infrastructure-in-workflow]` (channel transport is infrastructure). Different
  questions to different people are different roles; one question to several places, or a place
  chosen by the request's data, is one implementation that does it inside. Child workflows' tools
  count too: their roles need an implementation in the parent's application.
- **`send(ask: ChannelAsk<Role>): Promise<ChannelOutcome<Role>>`** is the one method: `ask` is
  `{ pauseId, value }` (the value typed by the generated `ChannelRoles` table — `agboss check`;
  `ChannelQuestionOf<Role>` is the question, `ChannelAnswerOf<Role>` the answer `decided` takes;
  the execution through `deps`). `ChannelOutcome.awaitReply()` — the execution pauses and is saved
  until the reply ([Pause seam](Pause-seam)); `ChannelOutcome.decided(decision)` — the answer now
  (a rule such as "up to $50 at once", `AutoApproveChannel`): no pause, the decision validated like
  a reply. A `send` that returns anything else fails the step.
- Not yet (#267 PR 2 / PR 3): resuming by `pauseId`, `answeredBy` checked on `resume`, several
  pauses at once, free-text replies through `@ReplyInterpreter`. Choosing an implementation per
  environment (a terminal in dev, Slack in prod) is a documented limit: one implementation per
  application.

## Testing

A tool is a plain class: construct it with fakes and call it through the same adapter the agent loop
uses — `toolOf` validates the input and output DTOs and maps errors exactly like a real call:

<!-- snippet-context
import { ExecutionContext, InjectionToken, Tool, type ToolHandler } from "agboss";
import { Text } from "agboss/dto";
interface IssuesApi { search(query: string): Promise<{ title: string }[]> }
const ISSUES_API = new InjectionToken<IssuesApi>("ISSUES_API");
class IssueQuery { @Text() query!: string; }
class IssueCount { @Text() summary!: string; }
@Tool({ name: "count_issues", description: "Counts issues", input: IssueQuery, output: IssueCount, deps: [ExecutionContext, ISSUES_API] })
class CountIssues implements ToolHandler<IssueQuery, IssueCount> {
  constructor(private readonly executionContext: ExecutionContext, private readonly issuesApi: IssuesApi) {}
  async run({ query }: IssueQuery): Promise<IssueCount> {
    this.executionContext.signal.throwIfAborted();
    return { summary: `${String((await this.issuesApi.search(query)).length)} issues` };
  }
}
-->

```ts
import { expect, test } from "vitest";
import { testExecutionContext, toolOf } from "agboss/testing";

test("counts the issues the API found", async () => {
  const fakeApi = { search: () => Promise.resolve([{ title: "a" }, { title: "b" }]) };
  const tool = toolOf(new CountIssues(testExecutionContext(), fakeApi));

  const result = await tool.invoke({ query: "login" });

  expect(result).toEqual({ kind: "ok", value: { summary: "2 issues" } });
});
```

In a workflow test the tool's dependencies are replaced with `mockOf(Service)`, and
`app.tool(CountIssues).invoke(input)` runs the tool alone with the app's real (or mocked)
dependencies, in an execution of its own (its `ExecutionContext` reads `step.callId`
`"tool-slice"`) ([Testing](Testing)).
