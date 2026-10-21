# Testing — `agboss/testing`

Test an application without models and without the network, from its first day: the real
container, components and graph rules of every workflow, with **everything external replaced
automatically**. `testWith(Application)` is the only form (#261) — `testWith(Workflow)` does not
compile; one workflow is tested through its start with `app.execute`, and a library workflow
through a small test `@Application` of its own. Vitest (≥ 3.2) is an
optional peer dependency.

```ts
// vitest.config.ts — one line registers the matchers
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { setupFiles: ["agboss/testing/setup"] } });
```

<!--
```ts file=job-scout.ts
import { Agent, Application, DecidedBy, Injectable, EmptyEnvironment, Tool, type ToolHandler, TerminalUserChannel, route, Router, start, Workflow, WorkflowFinish, WorkflowStart } from "agboss";
import { ListOf, Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { McpServer, McpServerClient, McpTool } from "agboss/mcp";
const model = "moonshotai/kimi-k2.6";
export class FileRead { @Text() path!: string; }
export class FileContent { @Text() content!: string; }
export class FileWrite { @Text() path!: string; @Text() content!: string; }
const tools = { read_text_file: { input: FileRead, output: FileContent }, write_file: { input: FileWrite, output: FileContent } };
@McpServer({ name: "shortlist", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], tools })
export class ShortlistServer extends McpServerClient<typeof tools> {}
export class ChosenJob { @Text() title!: string; @Text() link!: string; }
export class ChosenJobs { @ListOf(ChosenJob) jobs!: ChosenJob[]; }
export class SavedJobs { @ListOf(Text) added!: string[]; }
@McpTool({
  server: ShortlistServer,
  name: "save_shortlist",
  description: "Saves jobs",
  channel: TerminalUserChannel,
  input: ChosenJobs,
  output: SavedJobs,
  deps: [ShortlistServer],
})
export class SaveShortlist implements ToolHandler<ChosenJobs, SavedJobs> {
  constructor(private readonly server: ShortlistServer) {}
  async run({ jobs }: ChosenJobs): Promise<SavedJobs> {
    await this.server.call("write_file", {
      path: "shortlist.md",
      content: jobs
        .map((job) => job.link)
        .join("\n"),
    });
    return { added: jobs.map((job) => job.title) };
  }
}
@Injectable()
export class OrderBook { statusOf(orderId: string): Promise<string> { return Promise.resolve(`order ${orderId} shipped`); } }
export class OrderQuery { @Text() orderId!: string; }
export class OrderInfo { @Text() status!: string; }
@Tool({ name: "order_status", description: "An order's status", input: OrderQuery, output: OrderInfo, deps: [OrderBook] })
export class OrderStatus implements ToolHandler<OrderQuery, OrderInfo> {
  constructor(private readonly book: OrderBook) {}
  async run({ orderId }: OrderQuery): Promise<OrderInfo> { return { status: await this.book.statusOf(orderId) }; }
}
export class JobQuery { @Text() query!: string; }
export class JobList { @ListOf(Text) jobs!: string[]; }
@Tool({ name: "greenhouse_jobs", description: "Finds jobs", input: JobQuery, output: JobList })
export class GreenhouseJobs implements ToolHandler<JobQuery, JobList> { run(): Promise<JobList> { return Promise.resolve({ jobs: [] }); } }
@Agent({ name: "scout-agent", description: "Finds jobs", prompt: "Find jobs.", model, tools: [GreenhouseJobs, OrderStatus] }) export class Scout {}
@Agent({ name: "shortlist-agent", description: "Saves jobs", prompt: "Save jobs.", model, tools: [SaveShortlist] }) export class Shortlist {}
@Agent({ name: "writer-agent", description: "Writes", prompt: "Write.", model }) export class Writer {}
@Agent({ name: "reviewer-agent", description: "Reviews", prompt: "Review.", model }) export class Reviewer {}
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
@Router({ name: "main-router", description: "Routes", decidedBy: DecidedBy.Model, prompt: "Pick who handles the message.", model: "typesafe/jev-1.13", input: { message: WorkflowStartTextDto }, routes: [{ prompt: "Finding jobs", target: Scout }, { prompt: "Saving jobs", target: Shortlist }, { prompt: "Writing", target: Writer }, { prompt: "Reviewing", target: Reviewer }] })
export class MainRouter {}
@Workflow({
  name: "job-scout-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter)
      .chooseOne(
        route(Scout)
          .toFinish(ChatWorkflowFinish),
        route(Shortlist)
          .toFinish(ChatWorkflowFinish),
        route(Writer)
          .toFinish(ChatWorkflowFinish),
        route(Reviewer)
          .toFinish(ChatWorkflowFinish),
      ),
  ],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" },
  },
  uncompactedTurns: 5,
  mcp: [ShortlistServer],
  providers: [OrderBook],
})
export class JobScout {}
@Application({ name: "job-scout-application", version: "1.0.0", environment: EmptyEnvironment, workflows: [JobScout] })
export class JobScoutApplication {}
```
-->

<!-- snippet-context
import { ChatWorkflowFinish, ChatWorkflowStart, GreenhouseJobs, JobScout, JobScoutApplication, MainRouter, OrderBook, OrderStatus, Reviewer, SaveShortlist, Scout, Shortlist, ShortlistServer, Writer } from "./job-scout.js";
const job = { title: "Senior Engineer", link: "https://boards.greenhouse.io/acme/jobs/1" };
-->

```ts
import { replyWith, callTool, routeTo, testWith } from "agboss/testing";
import { expect } from "vitest";

const test = testWith(JobScoutApplication);

test("saving waits for approval; after it the agent's answer ends the turn", async ({ app, mockLlm, mcpOf }) => {
  mockLlm(MainRouter).thenReturn(routeTo(Shortlist)); // one router call: the agent's answer finishes the turn
  mockLlm(Shortlist).thenReturn(callTool(SaveShortlist, { jobs: [job] }), replyWith("Saved 1 job."));
  mcpOf(ShortlistServer).thenReturn({
    read_text_file: () => Promise.reject(new Error("ENOENT")),
    write_file: () => Promise.resolve({ content: "ok" }),
  });

  const paused = await app.execute(ChatWorkflowStart, { text: "save the first job" });
  const pauseId = paused.pending[0]?.pauseId ?? ""; // a ThreadOwner pause lists its id (Pauses)
  const done = await app.resume({ pauseId, decision: { approved: true } });

  expect(paused).toHavePausedAt(Shortlist);
  expect(done).toFinishWith(ChatWorkflowFinish, { text: "Saved 1 job." });
  expect(mockLlm(MainRouter).requests).toHaveLength(1);
});
```

Components are referenced **by class** everywhere; strings only for data.

## `testWith(Application, { real?, allowNetwork?, instances?, concurrency?, overrides? })`

A Vitest `test` whose fixtures are:

| Fixture   | What it is                                                                                 |
| --------- | ------------------------------------------------------------------------------------------ |
| `app`     | the application's [App](App) (`execute`, `resume`, `cancel`, `close`) — built on first use (`execute`, or `await app.ready()` for a test that executes nothing; a second `ready()` does nothing), so `mockOf` in the test body takes effect; plus `app.clock` and slices |
| `mockLlm` | the script of an agent or a router: `mockLlm(Scout).thenReturn(…)`                            |
| `mockOf`  | a typed mock injected instead of a component (a budget too: `mockOf(TenantDailyBudget).maxSpend`) |
| `mcpOf`   | the stub of an MCP server                                                                  |
| `apps`    | with `testWith(App, { instances: 2 })`: every instance of the application (`apps[0]` is `app`), each its own container and instance id, over one set of stores and one clock ([Several instances](Several-instances#testing-several-instances)) |
| `clock`   | the test's [`VirtualClock`](#the-clock) — the application's `Clock`, shared by its instances: `await clock.advance(seconds(31))` |
| `recoverApp` | `await recoverApp()` closes the current app (its `onStop` hooks run, as on a real stop) and returns a new one over the same test state (the infrastructure the first app created — checkpoints, records, ledger, paused executions — the clock, the ids); the closed app fails every call with `test.app-closed` |

The whole application is assembled when the test starts: a broken workflow fails every test of
the file before it runs, the message naming it.

**Isolation.** Each test gets a new container, new instances of every provider and new
infrastructure: the implementations the application lists (`@Application({ providers })`), else
the built-in in-memory defaults — nothing is substituted, and nothing one test leaves is seen by
the next.

### Everything external is replaced

- **Models** → scripted (the model gateway is replaced). An agent or router without a script is a
  blocked live call. Guardrails nobody scripted **pass** (`mockLlm(G).thenReturn(decideWith({ blocks:
  0.9 }))` blocks); a `@Compaction` nobody scripted writes a fixed summary
  (`mockLlm(ConversationCompaction).thenReturn(replyWith("…"))` scripts it, #120 PR 3).
- **MCP servers** → stubs: `mcpOf(Server).thenReturn({ <server tool>: handler })`; `.calls` lists what
  the server got. A server tool without a handler fails the test with the server's and the tool's
  name. `real: [Server]` connects that server for real (an integration test).
- **Network** → blocked: any `fetch` or `node:http(s)` request to a host not in `allowNetwork` fails
  before it leaves the process. `allowNetwork: ["localhost"]` covers every loopback address
  (`127.0.0.1`, `::1`).

A blocked call fails with **`test.live-call-blocked`** and a message naming the class, the server
tool or the host — even when the run swallowed it (a tool error the agent read): the call that ran
it (`app.execute`, `app.resume`, a slice) throws it.

## Scripted models

<!-- snippet-context
import { ModelFailure, callTool, failWith, replyWith, routeTo, testWith } from "agboss/testing";
import { ChatWorkflowFinish, ChatWorkflowStart, GreenhouseJobs, JobScout, JobScoutApplication, MainRouter, OrderBook, OrderStatus, Reviewer, SaveShortlist, Scout, Shortlist, ShortlistServer, Writer } from "./job-scout.js";
testWith(JobScoutApplication)("scripts", ({ mockLlm }) => {
// @snippet
});
-->

```ts
mockLlm(Scout).thenReturn(callTool(GreenhouseJobs, { query: "TypeScript" }), replyWith("3 jobs found"));
mockLlm(MainRouter).thenReturn(routeTo(Scout), routeTo(Writer)); // one decision per run
mockLlm(Writer).thenReturn(replyWith("first")).thenReturnAlways(replyWith("again"));
mockLlm(Reviewer).thenReturn(failWith(ModelFailure.Timeout));
```

| Turn                                              | Meaning                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `replyWith(text, { cost?, truncated? })`             | the agent's model answers; `cost: usd(0.002)` is priced as output tokens       |
| `replyWith(Dto, value, { cost? })`                  | an agent with `output` answers through its answer tool (`answer-<dto>`): a class of its output — a class outside its `oneOf` does not compile (#262); a list output with an array; `cost` is the execution's spend |
| `callTool(Tool, args)`                            | the agent's model calls a tool — `args` typed by the tool's input DTO          |
| `routeTo(...targets)`, `routeTo(Target, { reason?, confidence?, cost? })` | what the router's model chose, checked against `Route<R>` (#262, Q55): exactly one target after `.chooseOne(…)`; before `.toParallelAgents(…)` the `OnDemand` targets it launches — `routeTo()` only with an `Always` route, an `Always` target does not compile |
| `decideWith(answers, { cost? })`                  | a decision model answers by question id (a judge, a model arbiter, a router before a launch) |
| `waitFor(seconds(31))`                            | not a call of its own: the next turn answers only after that long on the test's clock (`clock.advance`) |
| `failWith(ModelFailure.Timeout \| RateLimited \| ServerError \| NetworkError)` (the same enum as `agboss/models`) | the call fails: an agent fails the run at the agent, a router with `RouterFailedError` (`step.router`, the failure as its cause) |

- **By position, never by call order across components:** a component's n-th model call gets its
  n-th turn, counted over the whole test (every run and every app of it). LangGraph never repeats a
  checkpointed call, so a run resumed after `recoverApp()` continues the same script — "a paused run survives a restart".
- A script shorter than the run fails with `test.script-exhausted`
  (`script exhausted for Writer: 1 turn scripted, asked for #2`) — or end it with `.thenReturnAlways(turn)`.
- `routeTo(X)` for a node that is not among the router's routes fails with `test.not-a-route`; an
  agent scripted with `routeTo` or a router with `replyWith` fails with `test.wrong-script` — for a
  component the generated types know (`agboss check`), both do not compile. A judge or an arbiter
  (no generated entry) is scripted unchecked.

### Binding turns to the input — `when(…)`

`mockLlm(X).when(partial)` gives its turns to the calls whose input matches, whatever their order or
depth; the calls no `when(…)` matches take the script's own turns. The partial is over **values**,
typed by `PartialValues<InputOf<X>>` (#262): a deep partial of each field's `value` — the producer
is not compared (where a value came from is `toFollowPath`'s and `agboss describe`'s), so moving a
step does not break a data script; a misspelled field does not compile. Agents and model routers
only.

<!-- snippet-context
import { replyWith, routeTo, testWith } from "agboss/testing";
import { JobScoutApplication, MainRouter, Scout, Writer } from "./job-scout.js";
testWith(JobScoutApplication)("when", ({ mockLlm }) => {
// @snippet
});
-->

```ts
mockLlm(MainRouter).when({ message: { text: "find jobs" } }).thenReturn(routeTo(Scout));
mockLlm(MainRouter).when({ message: { text: "write it up" } }).thenReturn(routeTo(Writer));
mockLlm(Scout).thenReturn(replyWith("3 jobs found"));
mockLlm(Writer).thenReturn(replyWith("A summary."));
```

- A key left out is not checked; a key given as `undefined` matches only an absent field —
  `when({ review: undefined })` for the first visit of a loop, `when({ review: { status: … } })` for
  the next.
- A `listOf` field is compared by length and position (`when({ companies: [] })` is an empty list);
  a `oneOf` element may be `variant(CompanyScoreDto, { score: 9 })` to match its class too. A
  `historyOf` field takes `{ current?, previous? }`. Vitest's asymmetric matchers
  (`expect.stringContaining(…)`) work anywhere.
- A call no script matches fails the test, naming its input: `test.no-matching-script` —
  `no script of mockLlm(Scout) matches the input {"profile":{"summary":"Go"}}`; a `when(…)` that ran
  out fails as `test.script-exhausted`.

### A script is an expectation

When the test's body passed, a `thenReturn` turn no call took, a `when(…)` nothing matched and a
`mockTool(…).thenFail(…)` no call caused fail the test at its end (`test.unused-script`, each one
named: `mockLlm(MainRouter): 1 scripted turn never used`). A `thenReturnAlways` turn is never one —
use it for a call that may or may not come (a router with one route decides without its model). A
test that already failed reports its own failure, not the leftovers. A branch cancelled while it
waits never answers: script only what it gets to.

### Parallel launches

A router before `.toParallelAgents(…)` (#273) decides its `OnDemand` routes with one yes/no per
route: script it with `routeTo(...)` — the `OnDemand` targets it launches, `routeTo()` for none
(only with an `Always` route) — or with `decideWith`, P(yes) per target `name`; on a decision
model and on a chat model alike (for a chat model, above 0.5 is `true` in its answer tool):

<!-- snippet-context
import { decideWith, testWith } from "agboss/testing";
import { JobScoutApplication, MainRouter } from "./job-scout.js";
testWith(JobScoutApplication)("launch decisions", ({ mockLlm }) => {
// @snippet
});
-->

```ts no-check: MainRouter of this page chooses one route; a launching router takes the same lines
mockLlm(SupportRouter).thenReturn(routeTo(RefundPolicyAgent), routeTo());
mockLlm(SupportRouter).thenReturn(decideWith({ "refund-policy-agent": 0.9, "loyalty-agent": 0.1 }));
```

Branches run one at a time in a test, in listed / item order
([Parallel branches](#parallel-branches--testconcurrency)), so the copies of one agent (and the
runs of a per-item launch) take their turns by copy and item; under `TestConcurrency.Real` they take
them in the order they call their model. When a reply must fit the item, answer by the request with
`.thenAnswer(…)` (below), or bind it to the item with `when(…)`. The join's values keep listed / item order
whatever order the branches answered in; assert on `result.launches` (`items`, `taken`, each
branch's `status`) and on `result.path`, where a copy is `critic-agent#2` — `toFollowPath` takes
the class for each copy (`[…, CriticAgent, CriticAgent, …]`).

### Quorums and arbiters

A model arbiter (#279) is scripted like a decision model, by its class, with one answer per arriving
answer — the question's key is `counts`: `mockLlm(ValidScoreArbiter).thenReturn(decideWith({ counts:
0.9 }))` (on a chat model alike: above 0.5 is `true`). Its requests show what it judged: the
criterion (`questions.counts.instructions`) and the answer under `### answer (from <agent>)`; answer
by the agent with `.thenAnswer(…)`. A code arbiter calls no model — it runs as written; `mockOf(Arbiter)`
replaces it. The answers arrive in the order the branches complete: one at a time by default, in
the order a test gives with `TestConcurrency.inOrder([step(A), step(B)])`
([Parallel branches](#parallel-branches--testconcurrency)) — or, for one late answer past a
deadline, an agent with a tool that waits on the application's clock and the `clock` fixture moved
(`await clock.advance(seconds(31))`). Assert on `result.launches[0]`:
`isQuorumReached`, `group`, and each branch's `status`, `verdict`, `acceptedSequence`, `rejectedBy`.

### Reply interpreters

A model reply interpreter (#267 PR 3) is scripted by its class, its input the pause's `{ ask, reply }`
— so `when(…)` binds a turn to the reply it reads, and its answer is the role's answer DTO:

<!-- snippet-context
import { ToolCallApprovalDecisionDto } from "agboss/dto";
import { replyWith, type ModelScript } from "agboss/testing";
declare function mockLlm(target: unknown): ModelScript;
declare class RefundReplyInterpreter {}
-->

```ts
mockLlm(RefundReplyInterpreter)
  .when({ reply: "ok, but only half" })
  .thenReturn(
    replyWith(ToolCallApprovalDecisionDto, {
      approved: true,
      overrideArguments: { orderId: "7", amountCents: 500 },
    }),
  );
```

A text reply (`replyWith("I cannot tell")`) is the model declining: `app.resume` throws
`UninterpretableReplyError` and the pause stays pending. `.inputs` lists what it read; its request
is a chat request (`system`: the framework's text and its `prompt`; `input`: `### ask` and
`### reply`). An interpreter on a decision model (an approval role's, #267 S124) answers its one
yes / no question — `mockLlm(DepositReplyInterpreter).thenReturn(decideWith({ approved: 0.9 }))`
approves (P(yes) > 0.5), `decideWith({ approved: 0.2 })` refuses, `{ cost: usd(…) }` its spend; its
request is `{ kind: "decide", state, questions: { approved: { type: "noul", … } } }`, the state the
masked `### ask` / `### reply`. A code interpreter calls no model (`mockLlm` of it is a setup error) —
the container creates it as written, and `mockOf(Interpreter).interpret.mockReturnValue(ReplyInterpretation.understood({ approved: false }))`
(or `ReplyInterpretation.notUnderstood({ reason })`) replaces it; a plain object does not compile.

### What a component sent its model

`mockLlm(X).requests` (every request, in order), `.onlyRequest` (fails unless exactly one),
`.lastRequest`, `.toolCalls`. An agent's request is `{ kind: "chat", system, input, messages }`
(`messages`: `{ role, text }` — tool results have role `tool`); a router's is
`{ kind: "decision", input, options, routes, instructions }`; a decision judge's
`{ kind: "decide", input, state, questions }`.

## Parallel branches — `TestConcurrency`

How a test runs the branches of a parallel launch (#262 S33) is its `concurrency` option:

| `testWith(App, { concurrency })`             | Branches                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `TestConcurrency.Sequential` (the default)   | one at a time, in listed / item order: every run the same, without saying so                 |
| `TestConcurrency.Real`                       | as in production: at once, within `maxConcurrency` (a sliding window)                       |
| `TestConcurrency.inOrder([step(A), step(B)])` | start as usual within `maxConcurrency`; **complete** in that order, through completion gates |

Under `inOrder` each branch runs to its completion point — its node answered or threw — and waits
at its gate; the listed steps complete strictly in list order, the unlisted branches after them in
item order. A gate opens once the branch released before it has ended, so what a completion does — a
`FailFast` abort, a quorum decided — lands before the next completes. `step(Node, partial?)` names a
branch with the matcher of `when(…)` (`PartialValues<InputOf<Node>>`; none = any branch of the node,
a repeated step = the next copy); it never supplies an input.

- **A race, the same every run:** `inOrder([step(FailingAgent), step(SlowAgent)])` — the failure
  completes first and `SlowAgent`, waiting at its gate, ends `Cancelled`; listed the other way round,
  `SlowAgent` finishes. A quorum counts the listed steps in their order (`acceptedSequence`), and a
  branch still waiting when it is decided is cancelled at its gate.
- **A waiting step listens to its signal:** a `FailFast`, a decided quorum or `app.cancel` ends it
  at once as `Cancelled`, whatever its place in the list.
- **No silent hang:** when no branch can move and the next listed step is not waiting at its gate
  — a step the router never launched, or a slot `maxConcurrency` keeps for a branch that waits —
  the execution fails at once with `test.unreachable-step`, naming the step and the waiting
  branches. A listed step never reached fails the test at its end, like an unused `when(…)`.
- **A limit:** the gates see the branches already dispatched. With executions running at once (two
  `app.execute` calls, `{ instances: 2 }`), a step of a launch another execution has not reached
  yet can be reported unreachable — order the steps of one execution at a time.

<!-- snippet-context
declare class PanelApplication {}
declare class PanelWorkflowStart {}
declare class SkillsAgent {}
declare class RisksAgent {}
declare class HireAgent {}
declare class PanelSummaryAgent {}
declare class ScoreDto {
  score: number;
}
declare class ScoreReviewDto {
  text: string;
}
declare const candidate: never;
-->

```ts
import { expect } from "vitest";
import { BranchStatus, BranchVerdict } from "agboss";
import { replyWith, step, TestConcurrency, testWith } from "agboss/testing";

// two of three count: the hire agent answers first, then the risks agent
const test = testWith(PanelApplication, {
  concurrency: TestConcurrency.inOrder([step(HireAgent), step(RisksAgent)]),
});

test("the first two answers count, the third is cancelled at its gate", async ({ app, mockLlm }) => {
  mockLlm(SkillsAgent).thenReturn(replyWith(ScoreDto, { score: 7 }));
  mockLlm(RisksAgent).thenReturn(replyWith(ScoreDto, { score: 6 }));
  mockLlm(HireAgent).thenReturn(replyWith(ScoreDto, { score: 9 }));
  mockLlm(PanelSummaryAgent).thenReturn(replyWith(ScoreReviewDto, { text: "summed up" }));

  const result = await app.execute(PanelWorkflowStart, candidate);

  expect(result.launches[0]?.branches).toMatchObject([
    { nodeId: "skills-agent", status: BranchStatus.Cancelled },
    { nodeId: "risks-agent", verdict: BranchVerdict.Counted, acceptedSequence: 2 },
    { nodeId: "hire-agent", verdict: BranchVerdict.Counted, acceptedSequence: 1 },
  ]);
});
```

A surplus answer — two answers for the last place at once — exists only under
`TestConcurrency.Real`: under `inOrder` the second waits at its gate and the decided quorum cancels
it there.

## `mockOf(Class)`

A typed mock (`vi.fn()` per method), injected instead of the class; inside the test `mockOf(X)`
returns the same instance the app uses:

<!-- snippet-context
import { expect } from "vitest";
import { testWith } from "agboss/testing";
import { ChatWorkflowFinish, ChatWorkflowStart, GreenhouseJobs, JobScout, JobScoutApplication, MainRouter, OrderBook, OrderStatus, Reviewer, SaveShortlist, Scout, Shortlist, ShortlistServer, Writer } from "./job-scout.js";
testWith(JobScoutApplication)("a mock", ({ mockOf }) => {
// @snippet
});
-->

```ts
mockOf(OrderBook).statusOf.mockResolvedValue("order lost");
// … run …
expect(mockOf(OrderBook).statusOf.mock.calls).toEqual([["7"]]);
```

Call it before the first `app.execute` (after it is a clear error). A class the workflow does not use
(not a provider, a tool or a knowledge base of it) is an error too. Mocks have no lifecycle hooks.

**Channels** (#267): a tool that names `AutoApproveChannel` / `AutoRejectChannel` decides at once —
no pause, no pause record. A role's implementation listed in the application is scripted like any
class: `mockOf(SlackRefundApprovalChannel).send.mockResolvedValue(ChannelOutcome.decided({ approved:
true }))` goes on at once; left as written, it pauses and the test answers like a webhook —
`app.resume({ pauseId, decision }, { answeredBy })` with the `pauseId` the channel was sent (a
`ThreadOwner` pause: `result.pending[0].pauseId`, with the thread's `ownerId`). Two pauses of one
tree answered at once from `apps[0]` and `apps[1]` (`instances: 2`) test the concurrent answers
([Pauses](Pauses#concurrent-answers)).

### `overrides` — a class replaced by a class

`testWith(App, { overrides: [override(Class, Replacement)] })` (#267 S104): wherever the application
asks for `Class`, its container creates `Replacement` instead — over any class the application lists,
with the replacement's own `deps`. It is the `override(…)` of the [unit runners](#unit-runners--one-component-on-its-own).
A channel role is answered in a test without its transport this way: the replacement need not
`extend` the role, but its `send` must take the role's `ChannelAsk` and give its `ChannelOutcome` —
a channel of another answer does not compile. There is no `channels` option; `mockOf(Implementation).send`
scripts the role's own implementation instead.


```ts no-check: the role's ChannelAsk / ChannelOutcome come from the generated types of a project
import { AutoApproveChannel } from "agboss";
import { override, testWith } from "agboss/testing";

// every refund the agent asks for is approved at once: no pause, no Slack
const test = testWith(RefundApplication, {
  overrides: [override(RefundApprovalChannel, AutoApproveChannel)],
});
```

## `mockAction(A)` and `mockTool(T)`

`mockAction(A)` (#262) watches an action — it still runs as written: `.inputs` is its input of every
call (`Produced` records, as it read them), and the call matchers below check what it — or an error
handler on a side path — received and returned. `mockTool(T).thenFail(ToolFailure.Timeout)` makes
the tool's next call fail as a real timeout would (the agent's model reads `timed out after 30000
ms`); the calls after the scripted failures run the tool. Both before the first `app.execute`.

<!-- snippet-context
import { expect } from "vitest";
import { callTool, replyWith, routeTo, testWith, ToolFailure } from "agboss/testing";
import { ChatWorkflowStart, JobScoutApplication, MainRouter, OrderStatus, Scout } from "./job-scout.js";
testWith(JobScoutApplication)("a tool timeout", async ({ app, mockLlm, mockTool }) => {
// @snippet
});
-->

```ts
mockTool(OrderStatus).thenFail(ToolFailure.Timeout);
mockLlm(MainRouter).thenReturn(routeTo(Scout));
mockLlm(Scout).thenReturn(
  callTool(OrderStatus, { orderId: "7" }), // times out
  callTool(OrderStatus, { orderId: "7" }), // runs the tool
  replyWith("Shipped, after a retry."),
);

await app.execute(ChatWorkflowStart, { text: "where is order 7?" });

expect(mockLlm(Scout)).toHaveBeenCalledTimes(3);
```

## Slices

One component of the real app on its own:

- `app.tool(X).invoke(input)` — the tool with its real (or mocked) dependencies → `ToolResult`; it
  runs in an execution of its own, so an injected `ExecutionContext` reads (`step.callId`
  `"tool-slice"`);
- `app.router(X).routeTo(text)` → the node it chooses;
- `app.agent(X).replyWith(task)` → its answer (its model, prompt and tools; no flow, no approval pause).

## Matchers

| Matcher                                          | On                       | Passes when                                          |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `toFollowPath([Start, Router, Agent, …])`           | a run result             | the visited nodes are exactly these, in order (node ids are the components' names; a launch's copy `critic-agent#2` is its class) |
| `toFinishWith(Finish, data?)`                    | a run result             | it finished there (with that output)                 |
| `toHavePausedAt(Agent)`                          | a run result             | it waits for a human in that agent                   |
| `toFailWith(ErrorClass, { …fields, cause? })`    | an error (`.rejects`)    | the error or one it was caused by is of that class (a subclass too) with those fields (deep partials); `cause` names a class further down the chain (#262) |
| `toHaveBeenCalledWith(partial)`                  | `mockLlm(X)`, `mockAction(A)` | a call's input matched — the `when(…)` matcher, typed by `InputOf<X>` |
| `toHaveBeenCalledTimes(n)`                       | `mockLlm(X)`, `mockAction(A)` | model calls of X (an agent that calls a tool and answers: 2), executions of A |
| `toHaveReturned(XDto, fields?)`                  | `mockLlm(X)`, `mockAction(A)` | it returned a value of that class (a text agent: `WorkflowFinishTextDto`) with those fields |
| `toHaveCalledTools([Tool, …])`                   | `mockLlm(Agent)`         | its model called exactly these tools, in order       |
| `toHaveBeenAskedWith({ input?, system?, … })`      | `mockLlm(X)`             | some request has these parts (strings as substrings) |
| `toHaveChildExecutions(W, [{ item, finish \| failedWith \| cancelled }, …])` | a run result | the executions of child workflow `W` in the result's tree, in item order, are exactly these (#263) |
| `toHaveHandledError(E, { at?, by? })`             | a run result             | an error of `E` (or caused by one) happened at `at` and the side path starting at `by` took it (#263) |

Failure messages name the classes: `expected the path ChatStart → MainRouter → Support, it was …`.
The call matchers keep Vitest's names; on anything that is not a script — a `vi.fn()`, a
`mockOf(…)` method — they are Vitest's own. `mockLlm(X).inputs` lists X's input of every call.

### Errors, caused the real way

The testing API cannot create a framework error by name: a test causes it — `failWith(ModelFailure.…)`,
a rejecting `mockOf(…)` method, `mockTool(T).thenFail(ToolFailure.Timeout)`, judges via
`decideWith`, a budget via `mockOf(Budget).maxSpend.mockReturnValue(usd(0.01))` plus a scripted cost,
`maxSteps` / `maxVisits` by scripts that reach them, a cancellation by `app.cancel` / `signal` (also
from inside a mock: `mockOf(MailerService).send.mockImplementation(() => app.cancel(threadId))`).
An application test checks its own reaction — its `.onError` path and its finish — not the
framework's counting; there is no `limits` option on `testWith`.

<!-- snippet-context
import { expect } from "vitest";
import { RouterFailedError } from "agboss";
import { failWith, ModelCallFailedError, ModelFailure, testWith } from "agboss/testing";
import { ChatWorkflowStart, JobScoutApplication, MainRouter } from "./job-scout.js";
testWith(JobScoutApplication)("a failed router", async ({ app, mockLlm }) => {
// @snippet
});
-->

```ts
mockLlm(MainRouter).thenReturn(failWith(ModelFailure.Timeout));

await expect(app.execute(ChatWorkflowStart, { text: "hi" })).rejects.toFailWith(RouterFailedError, {
  nodeId: "main-router",
  cause: ModelCallFailedError,
});
```


### Asserting outdating

`app.execute(…, { record: true })` returns `result.record` with both channels of the path scope
([Path scope → At run time](Path-scope#at-run-time)): `scope` (current values) and
`outdatedValues` (each with `outdated: { byValueId, reason }`). Ids are deterministic
(`${nodeId}:${visitNumber}/${slot}`), so a test names them:

<!-- snippet-context
import { expect } from "vitest";
import { OutdatedReason, type ExecutionOutput } from "agboss";
declare const result: ExecutionOutput;
-->

```ts
expect(result.record?.outdatedValues.map((value) => [value.valueId, value.outdated])).toEqual([
  ["writer-agent:1/DraftDto", { byValueId: "writer-agent:2/DraftDto", reason: OutdatedReason.Replaced }],
  [
    "reviewer-agent:1/ArticleChangesDto",
    { byValueId: "writer-agent:2/DraftDto", reason: OutdatedReason.AboutReplaced },
  ],
]);
expect(result.record?.scope.find((value) => value.slot === "DraftDto")?.value).toEqual({ text: "v2" });
```

An observer listed in `@Workflow({ observers })` sees each cascade as one `onValuesOutdated` event
([Observability](Observability#outdated-values)); `mockLlm(X).lastRequest.input` shows that no
outdated value reached the model.

### Child workflows

A child workflow (#263, [Workflow as a step](Workflow-as-a-step)) runs fully inside its parent:
script its agents with `mockLlm(…)` like the parent's. `result.children` holds a nested record per
child execution (`ChildExecutionRecord`), `result.handledErrors` every failure a side path took;
the two matchers read them:

<!-- snippet-context
import { expect } from "vitest";
import { ChildExecutionFailedError, StepsLimitExceededError, type ExecutionOutput } from "agboss";
declare class VendorCheckWorkflow {}
declare class VendorScoredWorkflowFinish {}
declare class ScreeningStoppedWorkflowFinish {}
declare const result: ExecutionOutput;
-->

```ts
expect(result).toHaveChildExecutions(VendorCheckWorkflow, [
  { item: { name: "Acme" }, finish: VendorScoredWorkflowFinish },
  { item: { name: "Globex" }, failedWith: StepsLimitExceededError }, // in the cause chain
  { item: { name: "Initech" }, cancelled: true }, // a sibling failed first (FailFast)
]);
expect(result).toHaveHandledError(ChildExecutionFailedError, {
  at: VendorCheckWorkflow,
  by: ScreeningStoppedWorkflowFinish,
});
```

`item` is the child's start input, or one field of a map input; `failedWith` matches the record's
error or a cause (`ChildExecutionFailedError` → `ActionFailedError` → your domain error). A child
that never started (the launch was aborted first) has no execution: it is a `Cancelled` branch in
`result.launches` only.

## Lifecycle and isolation

- Real components get `onInit` → `onStart` when the app is built and `onStop` → `onDestroy` after the
  test — also when the test failed ([App → Lifecycle hooks](App#lifecycle-hooks)).
- Per test: its own checkpoints, spend ledger, Terns and paused runs (in memory), deterministic ids
  (`thread-1`, `execution-1`, …, [Ids](#ids)) and a clock fixed at the start. Two tests — even in parallel, with the same
  thread id — never see each other.
- `await app.clock.advance("25h")` moves the time (units `ms`, `s`, `m`, `h`, `d`, or a value with
  its unit, `seconds(31)`): a daily budget (`BudgetPeriod.Day`) starts a new UTC day, its counter from zero. The work
  already started first reaches its next wait; then the time jumps and the framework's waits that
  are due wake in time order ([The clock](#the-clock)).

## The clock

All time in the framework is the application's `Clock` (#262) — `now()` and
`sleep(delay, signal?)`, infrastructure like the stores: the system's clock, unless
`@Application({ providers })` lists a class that `extends Clock`. In every test it is the test's
**`VirtualClock`** (`agboss/testing`) — whatever the application lists, since the test controls the
time — the `clock` fixture, `app.clock`, and what a component that injects `Clock` gets. `testWith` always runs on the `VirtualClock`, even when the application lists its own `Clock`: tests never run on real time.

- It starts at `2026-01-05T09:00:00.000Z` (so days and ids are reproducible) and moves only by
  `await clock.advance(…)`: the work already started first reaches its next wait, then the time
  jumps and every wait that is due wakes in time order (two due at one moment: in the order they
  began), each one's work running before the next wakes. A jump longer than a lease is a holder
  frozen for that long.
- What it moves, without real waiting: `applicationContext.startedAt`, the ledger's UTC day, the
  records' times, every lease's `expiresAt` and its renewals, a resume waiting for a tree's lease,
  the recovery sweep, the shutdown timeout, a tool's `timeoutMs`, a model call's timeout, the waits
  between retries and a `429`'s `Retry-After` pause (the circuit breakers are shared by the whole
  process and keep the system's time).
- A unit test of a component that needs the time passes one itself: `new VirtualClock()` (or
  `new VirtualClock(new Date("2026-03-01T00:00:00Z"))`).

```ts
import { Clock, Injectable } from "agboss";
import { VirtualClock } from "agboss/testing";
import { seconds } from "agboss/units";
import { expect, it } from "vitest";

@Injectable({ deps: [Clock] })
export class ReminderService {
  constructor(private readonly clock: Clock) {}

  async remindLater(): Promise<Date> {
    await this.clock.sleep(seconds(30));
    return this.clock.now();
  }
}

it("reminds after 30 seconds of the clock, at once", async () => {
  const clock = new VirtualClock();
  const reminded = new ReminderService(clock).remindLater();

  await clock.advance(seconds(30));

  expect((await reminded).toISOString()).toBe("2026-01-05T09:00:30.000Z");
});
```

The framework reads no time any other way: `Date.now()`, `new Date()` and `Date()` without
arguments, `performance.now()`, `setTimeout`, `setInterval`, `AbortSignal.timeout` and the
`node:timers` modules in its sources fail lint (`agboss/no-direct-time`, in `make check`) — the one
real implementation, `SystemClock`, excepted.

## Ids

Every thread id and execution id the framework mints comes from the application's `IdGenerator`
(#313, [App → Infrastructure](App#infrastructure)). Under `testWith` it is a
**`SequentialIdGenerator`** (`agboss/testing`) unless the application lists its own: `thread-1`,
`thread-2`, … for new threads and `execution-1`, `execution-2`, … for executions — a root before its
children, in the order they are made — counted from 1 in every test and shared by its instances
(`instances: 2`, `recoverApp()`), so a test names them. A caller's own `threadId` is used as given.
An application that lists an `IdGenerator` keeps it in its tests too. A `pauseId` never comes from
it: it stays a random 128-bit token (32 hex characters) — read it from `result.pending`.

<!-- snippet-context
import { expect } from "vitest";
import type { ExecutionOutput } from "agboss";
declare const paused: ExecutionOutput;
// @snippet
-->

```ts
expect(paused.threadId).toBe("thread-1");
expect(paused.runId).toBe("execution-1");
expect(paused.pending[0]?.childExecutionId).toBe("execution-2");
expect(paused.pending[0]?.pauseId).toMatch(/^[0-9a-f]{32}$/);
```

## Three kinds of tests

What each layer checks — scripts, then evaluation, then smoke: [The test split](Test-split).

`agboss create` sets up three Vitest projects by file name — empty ones pass:

| Project       | Files                     | Models                                   |
| -------------- | ---------------------------- | -------------------------------------------- |
| `unit`        | `*.test.ts`               | none — scripts and fakes                 |
| `integration` | `*.integration.test.ts`   | recorded answers ([VCR](#vcr--recorded-runs)), real MCP servers |
| `suites`      | `*.suite.test.ts`         | real models, budget-capped, scheduled    |

`npm test` runs unit + integration; the generated `test:suites` script (`vitest run --project suites`)
runs the suites. A new project's workflow test
(`src/<workflow>/<workflow>.workflow.test.ts`) scripts the main router and the first agent.

## Compile-time tests

Type mistakes are tested too: a `*.test.ts` line marked `// @ts-expect-error — <reason>` must stay a
compile error — `tsc` (in `make check`) fails when such a line compiles. One file per decorator family:

<!-- snippet-context
import { callTool } from "agboss/testing";
import { ChatWorkflowFinish, ChatWorkflowStart, GreenhouseJobs, JobScout, JobScoutApplication, MainRouter, OrderBook, OrderStatus, Reviewer, SaveShortlist, Scout, Shortlist, ShortlistServer, Writer } from "./job-scout.js";
-->

```ts
// @ts-expect-error — orderId is a string in the tool's input DTO
callTool(OrderStatus, { orderId: 42 });
```

What decorator mistakes look like in the compiler's output:

| Code   | Message (shortened)                                               | Typical cause                                              |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| TS1238 | Unable to resolve signature of class decorator …                  | `@Tool({ deps })` does not fit the constructor (order, type, count) |
| TS1240 | Unable to resolve signature of property decorator …               | a DTO field decorator on a field of another type (`@Text()` on a number) |
| TS1270 | Decorator function return type '…' is not assignable to type '…' | the class does not implement what its decorator requires (`ToolHandler`, `WorkflowDefinition`) |

Examples in the framework: `tests/components/compile-time.test.ts`, `tests/dto/types.test.ts`,
`tests/testing/types.test.ts`.

## Unit runners — one component on its own

A component is tested without a workflow by its unit runner (#262 S55, S62, S89): each builds the
component's own container — its `deps` resolved, `overrides: [override(Class, Replacement)]`
replacing classes by classes (no `new`, no instance: `provide(Class, …)` stays
`[di.instance-provider]`), the `environment` as `applicationContext.environment` — and runs every
call in the frame of its step, as the flow would: an `ExecutionContext` of the execution
`test-execution` (the component's step; the tenant and the execution's values the options give —
`tenantContext` / `tenant`, `executionContext` / `execution`, as [`testExecutionContext`](#testexecutioncontext--)
takes them and checked by the classes' field decorators, a wrong one a `DtoValidationError` when the
runner is made — else the default tenant), `executionContext.signal` aborting
after `timeout` on the runner's `VirtualClock` (`run.clock`), `SpendRecorder` and the component's
model calls into the call's `spend`. A component that calls a model answers from `model` — one turn
per call, a list for several (`replyWith`, `decideWith`, `routeTo`, `failWith`, typed like
`mockLlm(X).thenReturn(…)`). DTO values are plain objects; a step's input fields are
`{ producer, value }` records, the producer its class. Every call gives `{ output, spend }`; a
failure rejects as the component threw it.

| Runner                                  | A call                                                     | `output`                                    |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `testTool(Tool, options)`               | `run(input, { timeout })` — default the tool's `timeoutMs` | the output DTO (input and output validated) |
| `testAction(Action, options)`           | `run(input, { timeout })`                                  | what `execute` returned, checked against `output` |
| `testRouter(Router, options)`           | `run(input, { timeout })`                                  | the target(s) it chose (`Route<R>`)         |
| `testArbiter(Arbiter, options)`         | `run(Agent, answer, { timeout })`                          | whether the answer counts                   |
| `testRag(Rag, options)`                 | `run(query, { topK, timeout })`                            | its search results (`costUsd` → `spend`)    |
| `testJudge(Judge, options)`             | `run({ variant, reply, task, attempt }, { timeout })` — typed by the judge | its `JudgeVerdict`              |
| `testGuardrail(Guardrail, options)`     | `run(text, { element, timeout })`                          | `{ isBlocked, probability, refusal? }`      |
| `testPii([Policies], options)`          | `.mask(text)`, `.reveal(text)`                             | the masked text; the revealed one           |

<!-- snippet-context
import { OrderBook, OrderStatus } from "./job-scout.js";
-->

```ts
import { Injectable } from "agboss";
import { override, testTool } from "agboss/testing";
import { seconds } from "agboss/units";
import { expect, it } from "vitest";

@Injectable()
export class LostOrderBook extends OrderBook {
  override statusOf(orderId: string): Promise<string> {
    return Promise.resolve(`order ${orderId} lost`);
  }
}

it("looks the order up in the book it is given", async () => {
  const runStatus = testTool(OrderStatus, { overrides: [override(OrderBook, LostOrderBook)] });

  const { output, spend } = await runStatus({ orderId: "7" }, { timeout: seconds(1) });

  expect(output).toEqual({ status: "order 7 lost" });
  expect(spend.totalUsd).toBe(0);
});
```

- **`testTool`** runs `run` as an agent's tool call runs it: the input validated against its input
  DTO (`DtoValidationError`), the call's `step.callId`, its timeout (`ToolTimeoutError` — move
  `runStatus.clock` past it), the output validated; `SpendRecorder` records as `tool:<name>`.
- **`testAction`** takes what `execute` takes — `{ order: { producer: OrderIntakeAgent, value: { … } } }`
  — and checks the result against its `output` (`variant(XDto, value)` for a `oneOf`), spend as
  `action:<name>`.
- **`testRouter`**: a code router's `route(input)` on its container, at no cost; a model router's
  texts loaded (`prompt`, `promptUrls`, the route prompts, checked like at assembly) and its input
  message built from the fields, its model answering from `model` — `routeTo(X)` after
  `.chooseOne(…)`, `decideWith({ "<target>": 0.9 })` / `routeTo(…)` for the `OnDemand` routes of a
  launch; a target outside its routes is `RouterDecisionError`, a failed call `RouterFailedError`.
  A model router without its own `model` decides on a decision model, as `defaults.router` does.
- **`testArbiter`**: a code arbiter's `@OnAnswer(Agent)` method gets the answer; a model arbiter
  asks its model with the agent's criterion (`model: decideWith({ counts: 0.9 })`, spend as
  `arbiter:<name>`). One that throws, answers no boolean or whose model does not answer is
  `ArbiterError`, never a rejection.
- **`testRag`** calls `retrieve(query, { topK, signal })` (`topK` default the `@Rag`'s); its reported
  `costUsd` is the spend, as `rag:<name>`.
- **`testJudge`**: `reply` is a plain object of the judge's `reply` (`JudgeHandler<TReply>`: a
  `JobReportDto`, `OfferDto | RefusalDto`, `{ text }` for `PlainTextDto`), and `variant` the class it
  stands for (#262 S125: `JobReportDto`, `OfferDto` or `RefusalDto`, `PlainTextDto`; for a
  `listOf(oneOf(A, B))` judge no `variant`, each item `{ variant, value }`), passed to it as given —
  another shape, or a `variant` with another class's value (`{ variant: OfferDto, reply: { why } }`),
  does not compile (#262 S115, S125); the injected `JudgeModel` is the judge's own model
  answering from `model` — `decideWith(…)` on a decision model, `replyWith(…)` on a chat model; the
  wrong call for its kind is `ModelKindError`, as at run time. The output is the verdict,
  `JudgeVerdict.passed(…)` / `JudgeVerdict.failed({ reason })`.
- **`testGuardrail`** (#120 PR 2) checks the guardrail's own rules first (`-guardrail`, one refusal, a
  question, a threshold — a `GraphRuleError`), then asks its model on the text under its heading
  (`element` names the agent or router, default `test-agent`): `model: decideWith({ blocks: 0.9 })`
  (`{ cost }` for its spend, `guardrail:<name>`), unscripted it passes; a model that does not answer
  rejects with `GuardFailedError`. A block is the output `{ isBlocked: true, probability, refusal }`
  — the decorator's text or the class's `refusal()`, computed in the step's frame (`executionContext`
  / `execution` as given) — never a thrown `GuardrailBlockedError`. A guardrail without its own
  `model` decides on a decision model, as `defaults.guardrail.model` does.
- **`testPii`** checks the policies' own rules first (`[name.kind-suffix]` — a name ends with
  `-pii-policy` —, `[pii.conflicting-rules]`, …: one `GraphRuleError` with all of them), then
  `mask(text)` gives what a model would read — tokens made with a fixed test key and kept across
  calls, as an execution's `piiTokens` are; a block rule rejects with `PiiRefusedError` — and
  `reveal(text)` what its answer becomes; a `detectWithModel` policy answers from `model`
  (`replyWith('{"found":[{"kind":"person-name","text":"Anna Smith"}]}')`).

<!-- snippet-context
import { Decision, Injectable, Judge, JudgeModel, JudgeVerdict, PiiAction, PiiKind, PiiPolicy, pii, type JudgeHandler, type JudgeInput } from "agboss";
import { PlainTextDto } from "agboss/dto";
@Judge({ name: "grounded-judge", model: "typesafe/jev-1.13", reply: PlainTextDto, deps: [JudgeModel] })
export class GroundedJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}
  async judge({ reply, task }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const answers = await this.judgeModel.decide({
      state: { task, reply: reply.text },
      questions: { grounded: Decision.noul("Is the reply grounded in the task?") },
    });
    return answers.grounded.noul > 0.5
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed({ reason: "ground every claim in the task" });
  }
}
@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides contact details",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithToken())],
})
export class ContactPiiPolicy {}
-->

```ts
import { decideWith, testJudge, testPii } from "agboss/testing";
import { usd } from "agboss/units";
import { expect, it } from "vitest";

it("a grounded reply passes, at the decision's cost", async () => {
  const runJudge = testJudge(GroundedJudge, {
    model: decideWith({ grounded: 0.9 }, { cost: usd(0.003) }),
  });

  const reply = { text: "Acme hires TS engineers [acme.example]" }; // a PlainTextDto, as an object
  const { output, spend } = await runJudge({
    variant: PlainTextDto, // the class of a text agent's reply
    reply,
    task: "Find TS jobs",
    attempt: 0,
  });

  expect(output.passed).toBe(true);
  expect(spend.totalUsd).toBeCloseTo(0.003);
});

it("the model reads a token; its answer gets the address back", async () => {
  const contacts = testPii([ContactPiiPolicy]);

  const { output: masked } = await contacts.mask("Write to alice@example.com");

  expect(masked).toMatch(/^Write to <email:[0-9a-f]{6,}>$/u);
  expect(contacts.reveal(masked)).toBe("Write to alice@example.com");
});
```

## Lower level

A class created by hand — a budget's `maxSpend()`, a service — takes `testExecutionContext()`;
an MCP server's stub is `mcpServerStub(Server, handlers)`; fakes come from
`@langchain/core/utils/testing`.

### `testExecutionContext({ … })`

A component created without the container gets its `ExecutionContext` from
`testExecutionContext(options?)` (#280): a frozen root execution, readable at any time — no
execution running. What is not given takes its default: execution `test-execution`, its own thread,
no owner, a signal nobody aborts, workflow `test-workflow` (or the `@Workflow` class given as
`workflow`), step `test-step` on its first visit (or `step: { component, visitNumber, callId,
itemIndex, copyNumber }` — the step's name from the component's decorator). The idempotency key is
built as at run time. The levels above (#261): the tenant `"default"` of an application
`test-application` on the `test` environment — or `tenantContext` / `tenant`, `executionContext` /
`execution` (the project's subclasses and their values, checked by their decorators like at
`execute`) and `application: { name, version, environmentName, environment }`; a service of the
tenant or application level takes `testExecutionContext({ … }).tenant` or `.tenant.application`.

<!-- snippet-context
import { ExecutionContext, Injectable } from "agboss";
@Injectable({ deps: [ExecutionContext] })
export class ReceiptService {
  constructor(private readonly executionContext: ExecutionContext) {}
  keyOf(): string {
    return this.executionContext.step.idempotencyKey;
  }
}
-->

```ts
import { expect, test } from "vitest";
import { testExecutionContext } from "agboss/testing";

test("the receipt is keyed by the step", () => {
  const receipts = new ReceiptService(
    testExecutionContext({ executionId: "exec-1", step: { visitNumber: 2, callId: "call_1" } }),
  );

  expect(receipts.keyOf()).toBe("exec-1:test-step:2:call_1");
});
```


## Dynamic answers — `.thenAnswer()`

When the answer depends on the request, script a function instead of a list of turns:

<!-- snippet-context
import { callTool, replyWith, routeTo, testWith } from "agboss/testing";
import { ChatWorkflowFinish, ChatWorkflowStart, GreenhouseJobs, JobScout, JobScoutApplication, MainRouter, OrderBook, OrderStatus, Reviewer, SaveShortlist, Scout, Shortlist, ShortlistServer, Writer } from "./job-scout.js";
testWith(JobScoutApplication)("answers", ({ mockLlm }) => {
// @snippet
});
-->

```ts
mockLlm(Scout).thenAnswer((request) =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool")
    ? replyWith("Here are the jobs.")
    : callTool(GreenhouseJobs, { query: String(request.input) }),
);
mockLlm(MainRouter).thenAnswer((request) =>
  String(request.input).includes("save") ? routeTo(Shortlist) : routeTo(Scout),
);
```

## Blind spots

1. **Child workflows** (#263) run fully: script the child's agents like the parent's —
   `toHaveChildExecutions` / `toHaveHandledError` check how each child ended
   ([below](#child-workflows)).
2. **Side effects outside the container**: code that calls `fetch` directly is blocked like any live
   call and cannot be replaced with `mockOf` — put side effects in `@Injectable` services.
3. **The graph is tested by running it**: assembly rules are checked when the test starts; the paths
   a run can take are proven by the runs you script (`toFollowPath`).

## VCR — recorded runs

Instead of scripts, a test can answer from a **cassette**: recorded once with the real models, then
replayed in every later run — in milliseconds, without a key or network.

<!-- snippet-context
import { ChatWorkflowFinish, ChatWorkflowStart, GreenhouseJobs, JobScout, JobScoutApplication, MainRouter, OrderBook, OrderStatus, Reviewer, SaveShortlist, Scout, Shortlist, ShortlistServer, Writer } from "./job-scout.js";
-->

```ts
import { expect } from "vitest";
import { VCRMode, testWith } from "agboss/testing";

const test = testWith(JobScoutApplication, {
  vcr: {
    cassetteName: "onboarding", // __snapshots__/onboarding.cassette.json
    mode: process.env.CI ? VCRMode.REPLAY : VCRMode.AUTO, // the default already
  },
});

test("the scout answers a first message", async ({ app }) => {
  const result = await app.execute(ChatWorkflowStart, { text: "Hi, I'm looking for a job" });
  expect(result).toFinishWith(ChatWorkflowFinish);
});
```

1. **Recording** (first run, with a model key): every model call — agents, judges, compaction,
   routers, guardrails, decision judges — goes to the real model and is written to
   `<dir>/<cassetteName>.cassette.json` (`dir` defaults to `__snapshots__` under the working
   directory). Commit the cassette.
2. **Replay** (CI and later runs): answers come from the cassette. A call is matched by the model,
   the bound tools and every message; a request the cassette does not hold — a changed prompt, a new
   tool — fails with `CassetteMissingError` (`test.cassette-missing`): re-record it.

Modes: `VCRMode.AUTO` (default outside CI) records a missing cassette and replays an existing one;
`VCRMode.RECORD` always calls the models and rewrites the file; `VCRMode.REPLAY` (default under `CI`)
only replays and fails without a cassette.
