# Tools

A tool is a `@Tool` class in its workflow's `tools/` folder — see [Components](Components) for the
pattern (constructor dependencies, an `execute` method, tests with `new`).

<!-- snippet-context
import { InjectionToken } from "@agboss/core";
interface IssuesApi { search(query: string, signal: AbortSignal): Promise<IssueList> }
const ISSUES_API = new InjectionToken<IssuesApi>("ISSUES_API");
-->

```ts
import { ExecutionContext, Tool } from "@agboss/core";
import { List, Text } from "@agboss/core/dto";
import { seconds } from "@agboss/core/units";

export class Issue {
  @Text() title!: string;
  @Text() url!: string;
}

export class IssueQuery {
  @Text({ prompt: "words to search the issues for" })
  query!: string;
}

export class IssueList {
  @List(Issue)
  issues!: Issue[];
}

@Tool({
  name: "search-issues-tool",
  description: "Search the team's issues",
  input: IssueQuery,
  output: IssueList,
  timeout: seconds(10), // with units — there is no timeoutMs
  deps: [ExecutionContext, ISSUES_API],
})
export class SearchIssues {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly issuesApi: IssuesApi,
  ) {}

  execute({ query }: IssueQuery): Promise<IssueList> {
    return this.issuesApi.search(query, this.executionContext.signal);
  }
}
```

Input and output are DTO classes ([Components → DTOs](Components#dtos)); the model sees the input DTO's
JSON Schema, with each field's `prompt` as its description.

## Contract

| Step of `tool.invoke(raw)`                         | On failure                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| input validated against the input DTO             | `error: invalid input: <path>: <issue>` (`jobs[2].url`) — `execute` is not called |
| run is not started if the run is already cancelled | `error: <abort reason>`                                       |
| `execute` under its `timeout` and the run's `AbortSignal` | `error: timed out after 10 s` / `error: <message>`          |
| output validated against the output DTO           | `error: invalid output: …` — a contract bug of the tool       |

Results are values — `ToolResult = { kind: "ok", value } | { kind: "error", message }` — never
exceptions: the model sees `Tool error: …` and can recover.

`execute` gets only its input (#280 — there is no `ToolContext`). The execution it runs in comes through
the constructor: `deps: [ExecutionContext]` gives `executionId`, `threadId`, `ownerId`, `signal`,
`workflow` and the call's `step` (`callId`, `idempotencyKey`, …)
([Context and Authorization](Context-And-Authorization)). A tool's model spend through
`DecisionModel` is recorded as the tool's; what it pays a service that is not a model it records
with `deps: [SpendRecorder]` — `this.spendRecorder.record({ service, cost: usd(…) })`, counted in
the money limits ([FinOps](FinOps)).

## Names

A tool's `name` is what the model calls (#268 AC9, #1343a): letters, digits, `_` and `-`, at most 64
characters (`[tool.name-invalid]`, `[tool.name-too-long]`); no `-tool` suffix is needed (`search-issues`,
`search_issues`). A knowledge base has no tool of its own: a `@Tool` injects the `@Rag` (`deps: [JobsRag]`)
and calls `search(query)`, with the ready-made `RagQueryDto` / `RagSearchResultsDto` ([Knowledge bases](Knowledge-bases)).
The tools an MCP server offers keep the server's own names (`read_text_file`, declared in
`@McpServer({ tools })`) — a model never sees them, only the `@Tool` calling them. Every name a
model sees — the framework's answer tools (`answer-<dto>`) too — fits what the providers accept
(OpenAI, Anthropic, Gemini): `[a-zA-Z0-9_-]`, at most 64 characters (`[tool.name-too-long]`,
`[tool.name-invalid]`), and is unique over the agent's tools (`[tool.duplicate-name]`). All found at
assembly, at once, before any model call.

## Timeouts

A call runs under its tool's `timeout` — a value with units, `timeout: seconds(10)` (`@agboss/core/units`;
default 30 s); a bare number does not compile and there is no `timeoutMs` (#268 AC11). The timer runs
on the application's `Clock`, so a test's `clock.advance(…)` moves it.

## Result size

What a model reads of one tool result is bounded (#336), so one huge page or JSON cannot overflow the
model's context on the next turn of the loop: `maxResultSize`, in bytes of the UTF-8 text the model
reads, given with `kilobytes()` (`@agboss/core/units`, 1 KB = 1,024 bytes). The tool's own wins; else
`defaults.tools.maxResultSize` of its workflow, else of its application
([Configuration → `defaults.tools`](Configuration#defaultstools)); nothing set → 128 KB.

<!-- snippet-context
import { Injectable } from "@agboss/core";
import { Text } from "@agboss/core/dto";
@Injectable()
export class PageReader {
  textOf(url: string): Promise<string> {
    return Promise.resolve(url);
  }
}
export class PageQuery {
  @Text() url!: string;
}
export class PageContent {
  @Text() text!: string;
}
-->

```ts
// tools/fetch-page.tool.ts — a tool whose pages may be long sets its own
import { Tool } from "@agboss/core";
import { kilobytes, seconds } from "@agboss/core/units";

@Tool({
  name: "fetch-page-tool",
  description: "Fetches a web page as text",
  input: PageQuery,
  output: PageContent,
  timeout: seconds(10),
  maxResultSize: kilobytes(256),
  deps: [PageReader],
})
export class FetchPageTool {
  constructor(private readonly pageReader: PageReader) {}

  async execute({ url }: PageQuery): Promise<PageContent> {
    return { text: await this.pageReader.textOf(url) };
  }
}
```

- The bound applies to the **rendered** result — the JSON of the output DTO, or `Tool error: …` for a
  failed call — of a `@Tool` and a knowledge base's `search-<rag>-tool` alike. Over
  it, the text is cut at the last whitespace (space, tab, line break) within the final 256 bytes it
  keeps, else at the bound, never inside a character, and ends with
  `\n[result truncated: 1,048,587 bytes, the first 262,144 kept]` — a framework text the model reads,
  part of every workflow's `configHash`. The result stays useful; it is never turned into an error.
- It is cut **before** PII masking: the policies read only the kept part, the marker follows it in
  what the model reads and in the checkpoint.
- A knowledge base listed in an agent's `rag` is bounded the same way: each knowledge base's block in the
  agent's input message by the agent's `maxResultSize` (its workflow's `defaults.tools`, else 128 KB).
- `onToolEnd` carries `isResultTruncated` (`update` then ends with the marker,
  [Observability](Observability)); `agboss describe` prints each tool's bound and where it came from
  — `maxResultSize 64 KB (desk-application)`, `256 KB (own)`, `128 KB (built-in)` — and
  `describe --json` has it in bytes: `schemas.tools[name].maxResultSize` and each agent's
  `maxResultSize` (its context blocks and the tools without their own).
- A bound that is not a whole number of bytes from 1 (`kilobytes(0)`, `kilobytes(0.1)`) fails
  assembly with `[tools.max-result-size-invalid]`, naming the tool or the workflow, all at once.
- `testUnit(…).run` returns the tool's full output — the bound is what a model reads, not what a
  tool returns.

## Library and workflow tools

A tool lives in its workflow's `tools/` folder (the framework ships none). There is no central
registry: an agent's `tools: [SearchIssues]` **is** the registration.

## MCP

A server declares the tools it offers that the workflow uses (`@McpServer({ tools })`, `extends McpServerClient`);
a `@Tool` lists the server class in its `deps` and calls it in `execute` — see
[Components → MCP](Components#mcp). Secrets are `defineEnv` references in the config, never values.
A server tool that answers with plain text declares `output: PlainTextDto` (`@agboss/core/dto`, the one
field `text`) — the server's text arrives as `{ text }`; `agboss g mcp` writes that by default.

## Agents with tools

<!-- snippet-context
import { Agent } from "@agboss/core";
declare class GreenhouseJobs { execute(input: object): Promise<object> }
-->

```ts
// agents/scout.agent.ts — the workflow sets defaults.tools.maxToolCalls; an agent may override it
@Agent({
  name: "scout",
  description: "Finds jobs",
  prompt: "./scout.prompt.md",
  model: "moonshotai/kimi-k2.6",
  tools: [GreenhouseJobs],
  executionLimits: { maxToolCalls: 4 },
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
  included) combined with a timer of the tool's `timeout` (default 30 s), cleared when the call ends — so
  `fetch(url, { signal: this.executionContext.signal })` stops on a cancel and on the call's own
  timeout, while the execution goes on (the model reads `Tool error: timed out after 10 s`).
- `executionContext.step.callId` is the call's id — the same when a call interrupted by a crash
  runs again — and `executionContext.step.idempotencyKey`
  (`${executionId}:${nodeId}:${visitNumber}[:${itemIndex}]:${callId}`) the key a tool with side
  effects **must** pass to the external service. The key is unique per call (#335): a call the model
  gave no id gets one from its run, visit, turn and position, and an id the provider repeats within
  one move gets its position (`call_0:0`, `call_0:1`) — so two calls of one tool never share a key,
  and a recovered step replays the same ids.
- An instance that loses the tree's lease mid-loop — taken by another instance, or its lease store
  silent until the lease ran out — aborts `executionContext.signal` with `ExecutionLeaseLostError`
  and starts no further model or tool call
  ([Several instances → The execution lease](Several-instances#the-execution-lease)).
- Tool errors do not fail the run: the model reads `Tool error: …` and continues.

## Tool interceptors

A `@ToolInterceptor` (#384) wraps an agent's calls to its own `@Tool`s — a check
of the arguments against the tenant, an audit, a rewrite of a result — without touching the tools.
Its class has `@BeforeTool(Tool)` / `@AfterTool(Tool)` methods (the target-bound hooks, below),
plain `beforeAnyTool(call)` / `afterAnyTool(call)` methods for every tool, or both kinds. A class
with none is `[tool-interceptor.missing-handler]` at assembly; its `name` is optional (kebab-case,
the class name by default); its `deps` are injected by the container like any component's.

<!-- snippet-context
import { TenantContext } from "@agboss/core";
import { List, Text } from "@agboss/core/dto";
export class JobScoutTenantContext extends TenantContext {
  @List(Text)
  allowedCities!: string[];
}
-->

```ts file=src/scout/tenant-scope.tool-interceptor.ts
import {
  ToolCallDecision,
  ToolInterceptor,
  type ToolCallContext,
  type ToolCallResultContext,
} from "@agboss/core";

@ToolInterceptor({
  name: "tenant-scope-tool-interceptor",
  description: "Checks that tool arguments respect the tenant's allowed cities",
  deps: [JobScoutTenantContext],
})
export class TenantScopeToolInterceptor {
  constructor(private readonly jobScoutTenantContext: JobScoutTenantContext) {}

  beforeAnyTool(call: ToolCallContext): ToolCallDecision {
    if (
      typeof call.input === "object" &&
      call.input !== null &&
      "city" in call.input &&
      typeof call.input.city === "string" &&
      !this.jobScoutTenantContext.allowedCities.includes(call.input.city)
    ) {
      return ToolCallDecision.reply(`City "${call.input.city}" is not allowed for this tenant.`);
    }
    return ToolCallDecision.allow();
  }
}

@ToolInterceptor({ name: "result-stamp-tool-interceptor", description: "Marks results as checked" })
export class ResultStampToolInterceptor {
  afterAnyTool(call: ToolCallResultContext): unknown {
    return call.output; // the result the model reads: the tool's, or a replacement of its shape
  }
}
```

**Target-bound hooks.** `@BeforeTool(OrderStatusTool)` decides on that tool's calls with its
validated input DTO in hand, `@AfterTool(OrderStatusTool)` reads or replaces its output (and sees the
input); `@BeforeTool(A, B)` shares one method between tools — it takes the union of their inputs and
may rewrite the input only to what every one of them accepts. The `before` method returns a
`ToolCallDecision` (`ToolCallDecision<OrderLookupDto>` when it rewrites the input); a method taking
no input runs before the arguments are validated, one taking it is skipped for invalid arguments (the
tool answers its own invalid-input error). Which method serves which tool is read from the decorator,
never from a name or an arity. A target that is no tool is `[tool-interceptor.target-not-a-tool]`,
two methods for one tool and phase `[tool-interceptor.duplicate-hook]`, a method named like a hook
that is none (the 0.1.0 `beforeToolCall`) `[tool-interceptor.unknown-hook]`. `ToolCall.typeOf(call)`
gives the tool class of a catch-all's `call`, which also carries `agent` and `callId`.

<!-- snippet-context
declare class CityJobsTool {
  execute(input: { readonly city: string }): { readonly listing: string };
}
-->

```ts file=src/scout/city-jobs.tool-interceptor.ts
import { AfterTool, BeforeTool, ToolCallDecision, ToolInterceptor } from "@agboss/core";

@ToolInterceptor({ name: "city-jobs-tool-interceptor", description: "Normalises a city" })
export class CityJobsToolInterceptor {
  @BeforeTool(CityJobsTool)
  trimCity({ city }: { readonly city: string }): ToolCallDecision<{ readonly city: string }> {
    return ToolCallDecision.allow({ input: { city: city.trim() } }); // validated again, then the tool runs
  }

  @AfterTool(CityJobsTool)
  shorten({ listing }: { readonly listing: string }): { readonly listing: string } {
    return { listing: listing.slice(0, 200) };
  }
}
```

**Levels.** `toolInterceptors: [...]` on `@Application` → `@Workflow` → `@Agent` → `@Tool`:
the lists add up, outer first, each class once. `@Workflow({ excludeToolInterceptors })`
removes an application-level one for the whole workflow. `excludeToolInterceptors: [...]` on an
agent removes one its application or workflow lists; on a tool, one listed above it (by its
application, its workflow or an agent that calls it) — excluding one nothing above lists is
`[tool-interceptor.exclude-not-inherited]`, a class in a list that is not a `@ToolInterceptor` is
`[tool-interceptor.not-an-interceptor]`. A child workflow gets its own workflow's lists over the
application's.

**The before hooks decide**, in list order (outer first; an interceptor's `beforeAnyTool(call)` before its
`@BeforeTool` method); the first decision that is not `allow()` ends the chain:

| Decision                                   | The tool | The step                                                                                         |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `ToolCallDecision.allow()`                 | runs     | goes on (the next interceptor decides first)                                                     |
| `ToolCallDecision.allow({ input })`          | runs, with `input` | goes on (validated against the tool's input DTO again; the next hooks and the tool get it) |
| `ToolCallDecision.reply(message)`          | not called | goes on: the model reads `message` as the call's text result in its loop and may try again      |
| `ToolCallDecision.block(reason)`           | not called | fails at once: `ToolBlockedError` (`step.tool-blocked`, a `StepFailedError`: `agent`, `tool`, `interceptor`, `reason`) |

A decision is built only by its factories (a plain object does not compile); in tests compare it
with `toEqual(ToolCallDecision.reply(message))`. `.onError(ToolBlockedError, …)` (or
`StepFailedError`) right after the agent takes a block; the error carries the loop's spend, so the
record and the ledger keep it.

**The after hooks replace the result**, in reverse order (inner interceptor first; its `@AfterTool`
method, then its `afterAnyTool(call)`), on a successful
call only — a tool error goes to the model as it is. `call.output` is the tool's result (or what an
inner interceptor gave); the value returned is validated against the tool's output DTO before the
next one reads it.

**The order of one call**: the arguments checked against the tool's input → the arguments'
PII block rules → each before hook — the arguments as the tool gets them, PII tokens revealed
(`alice@example.com`, never `<email:7f3a91>`; `call.input` is `unknown`: narrow it) → the
approval, when the tool has one (its approver sees the arguments masked, as the hooks left them, and
nothing above is run again on resume) → the tool → each after hook → the
`maxResultSize` cut ([Result size](#result-size)) → the PII policies' masking. A `reply`
message is cut and masked the same way.

**In the call's frame**: an injected `ExecutionContext` reads the tool call — `step.callId`,
`step.idempotencyKey` with the call id, the call's `signal` (the execution's and the tool's
`timeout`). The interceptors themselves have no timer of their own.

**Failures.** An interceptor that throws, returns no `ToolCallDecision` or an output its tool does
not give fails the step: `AgentFailedError`, its error as the `cause` (`ScopeServiceDownError`,
`TypeError`, `DtoValidationError`), so `.onError(DomainError, …)` takes it through the cause; the
tool does not run after a failed before hook.

**What is intercepted**: an agent's calls to the project's `@Tool` classes — never
its answer tools, a knowledge base's `search-…-tool`, or a tool called on its own (over MCP,
`connectMcp`).

**Visible**: `agboss describe` prints

```
tool interceptors
  audit-tool-interceptor — before, after · on scout-agent: job-search-tool, ping-tool
  tenant-scope-tool-interceptor — before · on scout-agent: job-search-tool, company-tool, ping-tool
```

(`tool interceptors none` without one), `describe --json` each agent's `toolInterceptors` by tool
(only an agent that has one), and `configHash` covers each interceptor's methods and every chain —
a workflow without one keeps its hash.

**Tests**: on the whole application they run as in production; one on its own with
`testUnit` ([Testing](Testing)):

<!-- snippet-context
import { Tool, ToolCallDecision } from "@agboss/core";
import { Text } from "@agboss/core/dto";
import { testUnit } from "@agboss/core/testing";
import { JobScoutTenantContext, TenantScopeToolInterceptor } from "./src/scout/tenant-scope.tool-interceptor.js";
import { expect, it } from "vitest";
export class CityQuery {
  @Text({ prompt: "the city" })
  city!: string;
}
export class CityJobs {
  @Text({ prompt: "the jobs" })
  listing!: string;
}
@Tool({ name: "city-jobs-tool", description: "Jobs in a city", input: CityQuery, output: CityJobs })
export class CityJobsTool {
  execute({ city }: CityQuery): Promise<CityJobs> {
    return Promise.resolve({ listing: `Engineer in ${city}` });
  }
}
-->

```ts
it("a city outside the tenant's goes back to the model", async () => {
  const scope = testUnit(TenantScopeToolInterceptor, {
    tenantContext: JobScoutTenantContext,
    tenant: { tenantId: "acme", allowedCities: ["Haifa"] },
  });

  const { output } = await scope.beforeToolCall(CityJobsTool, { city: "Eilat" });

  expect(output).toEqual(
    ToolCallDecision.reply('City "Eilat" is not allowed for this tenant.'),
  );
});
```

`beforeToolCall(Tool, input)` → `{ output: ToolCallDecision, spend }`, `afterToolCall(Tool, input,
output)` → `{ output, spend }` (validated against the tool's output DTO); each call runs in the frame
of a call to that tool (`step.callId` `test-call`) for the tenant and execution given; a method the
class does not have is a `TestSetupError`, a broken rule a `GraphRuleError`.

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

A tool that needs a decision before it runs names a channel: `@Tool({ channel })` .
Channels are found through the tools that name them, like services through `deps` — there is no
`channelClasses` (#267) — and one instance serves every workflow of the application. A tool names
either a concrete `@Channel` as is (`AutoApproveChannel`,
`AutoRejectChannel`) or a **channel role** — the project's abstract class that says what it approves
and who may answer:

<!-- snippet-context
import { Agent, Application, EmptyEnvironment, Injectable, Workflow, WorkflowFinish, WorkflowStart, onStart } from "@agboss/core";
import { Integer, Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
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
  flow: [onStart(RefundWorkflowStart).toAgent(RefundAgent).toFinish(RefundWorkflowFinish)],
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
  } from "@agboss/core";

// channels/refund-approval.channel.ts — the role: what it approves, who answers
@ChannelRole({
  name: "refund-approval-channel",
  description: "Approves card refunds",
  approves: RefundCardInputDto, // the tools' input DTO — imports go DTO ← role ← tool
  answerer: PauseAnswerer.Channel,
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
    const cents: number = ask.input.amountCents; // typed by RefundCardInputDto
    const tenant = this.executionContext.tenant.tenantId;
    await this.slackService.post("#finance", `Refund ${String(cents)}¢ (${tenant})?`, ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}

// tools/refund-card.tool.ts — the tool names the role
@Tool({
  name: "refund-card-tool",
  description: "Refunds a card payment",
  input: RefundCardInputDto,
  output: RefundCardOutputDto,
  channel: RefundApprovalChannel,
})
export class RefundCardTool {
  execute({ orderId }: RefundCardInputDto): Promise<RefundCardOutputDto> {
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}
```

- **`@ChannelRole({ name, description, actor, approves, replyInterpreter? })`** — a tool
  approval: `approves: XDto` (the question is `ToolCallApprovalAskDto` with `arguments: XDto`, the
  answer `ToolCallApprovalDecisionDto` with `overrideArguments?: XDto`). A question role (`ask` /
  `answer`, #659) is asked by a flow step — `.toExternalTask(Role)`
  ([Pauses](Pauses#a-question-the-workflow-asks-toquestionrole-659)) — or by an agent that lists the
  role itself in its `tools` (#712, [Pauses](Pauses#an-agent-asks-a-question-role-as-a-tool-712));
  a `@Tool` naming one as its `channel` is `[channel.wrong-tool]`. `actor` is required —
  `PauseAnswerer.ThreadOwner` or `PauseAnswerer.Channel`, no default (`[channel.role-form]` without
  it, with both `approves` and `ask` / `answer`, or with neither). A tool whose `input` is not its role's `approves` fails assembly with
  `[channel.wrong-tool]`; one `replyInterpreter` class in two roles with
  `[channel.shared-interpreter]`. `replyInterpreter` is a `@ReplyInterpreter` class (#267 PR 3) that
  reads a free-text `app.resume({ pauseId, reply })` with the pause's question into the role's
  answer — by its chat model, for an approval role a decision model (approve / refuse only, #267
  S124), or by its code, which returns a `ReplyInterpretation` ([Pauses → free text](Pauses#answering-with-free-text-appresume-pauseid-reply--options)).
- **The implementation** is a `@Channel` that `extends` the role, listed in
  `@Application({ providers })` — found by inheritance, like any contract: none →
  `[di.missing-implementation]`, two → `[di.ambiguous-implementation]`; a `@Channel` in a workflow's
  `providers` → `[di.infrastructure-in-workflow]` (channel transport is infrastructure). Different
  questions to different people are different roles; one question to several places, or a place
  chosen by the request's data, is one implementation that does it inside. Child workflows' tools
  count too: their roles need an implementation in the parent's application.
- **`send(ask: ChannelAsk<Role>): Promise<ChannelOutcome<Role>>`** is the one method: `ask` is
  `{ pauseId, value }` (the value typed by the generated `AGBossTypes.ChannelRoles` table — `agboss check`;
  `ChannelQuestionOf<Role>` is the question, `ChannelAnswerOf<Role>` the answer `decided` takes;
  the execution through `deps`). `ChannelOutcome.awaitReply()` — the call pauses and is saved
  until the reply ([Pauses](Pauses), [Pause seam](Pause-seam)); `ChannelOutcome.decided(decision)` — the answer now
  (a rule such as "up to $50 at once", `AutoApproveChannel`): no pause, the decision validated like
  a reply, its pause record closed at once (`PauseResolution.Decided`). A `send` that returns
  anything else fails the step.
- **Who answers** (#267 PR 2): the role's `answerer`. A `PauseAnswerer.ThreadOwner` pause is
  answered with the thread's `ownerId` and its `pauseId` is listed in `result.pending`; a
  `PauseAnswerer.Channel` pause — the reply comes through the channel's own system — is answered
  with `app.resume({ pauseId: ask.pauseId, decision }, { actor: { id: "manager-17" } })`, its id never
  listed (it is the right to answer). The `pauseId` is made once per pause, before the first `send`:
  a retried `send` gets the same one — use it as the idempotency key of the post. Several pauses
  at once, concurrent answers, validation: [Pauses](Pauses).
- Not yet: choosing an implementation per
  environment (a terminal in dev, Slack in prod) is a documented limit: one implementation per
  application.

## Testing

A tool is tested on its own with `testUnit` (`@agboss/core/testing`, #262): its own container — its
`deps` resolved, `overrides` replacing classes by classes — and every call in the frame of a tool
call, as the agent loop runs it: the input and output validated against the DTOs, the call's
`executionContext.signal` aborting after `timeout` (default the tool's own `timeout`) on the runner's clock,
`SpendRecorder` into the call's `spend`. A failure rejects as the tool threw it
([Testing → Unit runners](Testing#unit-runners--one-component-on-its-own)):

<!-- snippet-context
import { ExecutionContext, Injectable, Tool } from "@agboss/core";
import { Text } from "@agboss/core/dto";
@Injectable()
export class IssuesApi {
  search(_query: string): Promise<{ title: string }[]> {
    return Promise.reject(new Error("the real issue tracker"));
  }
}
class IssueQuery { @Text() query!: string; }
class IssueCount { @Text() summary!: string; }
@Tool({ name: "count-issues-tool", description: "Counts issues", input: IssueQuery, output: IssueCount, deps: [ExecutionContext, IssuesApi] })
class CountIssues {
  constructor(private readonly executionContext: ExecutionContext, private readonly issuesApi: IssuesApi) {}
  async execute({ query }: IssueQuery): Promise<IssueCount> {
    this.executionContext.signal.throwIfAborted();
    return { summary: `${String((await this.issuesApi.search(query)).length)} issues` };
  }
}
-->

```ts
import { override, testUnit } from "@agboss/core/testing";
import { expect, test } from "vitest";

@Injectable()
export class TwoIssuesApi extends IssuesApi {
  override search(): Promise<{ title: string }[]> {
    return Promise.resolve([{ title: "a" }, { title: "b" }]);
  }
}

test("counts the issues the API found", async () => {
  const countIssues = testUnit(CountIssues, { services: [TwoIssuesApi] });

  const { output } = await countIssues({ query: "login" });

  expect(output).toEqual({ summary: "2 issues" });
});
```

In a workflow test the tool's dependencies are replaced with `mockOf(Service)`, and
`app.runTool(CountIssues, input)` runs the tool alone with the app's real (or mocked)
dependencies, in an execution of its own (its `ExecutionContext` reads `step.callId`
`"tool-slice"`) ([Testing](Testing)).
