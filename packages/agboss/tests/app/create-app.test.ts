import { describe, expect, it } from "vitest";
import { NotAWorkflowStartError, type AppOptions } from "../../src/app/create-app.js";
import { createApp } from "../../src/application/create-app.js";
import { Agent, Workflow, NotPausedError, GraphRuleError, WorkflowStart } from "../../src/index.js";
import { DtoValidationError, Text, WorkflowStartTextDto } from "../../src/dto/index.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { replyWith, callTool, routeTo } from "../../src/testing/index.js";
import { McpStubs, stubbedMcpConnect } from "../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { usd } from "../../src/units/index.js";
import {
  ChatStart,
  lifecycle,
  MainRouter,
  NotesServer,
  OrderBook,
  Reply,
  SaveNote,
  Support,
  Writer,
  DeskApplication,
} from "../testing/fixtures/desk.workflow.js";
import { TerminalUserChannel } from "../../src/channels/terminal-channel.js";
import {
  CodeDto,
  Coder,
  PullRequest,
  ReviewDto,
  Reviewer,
  ReviewGate,
  TaskStart,
  CodeReviewApplication,
} from "../testing/fixtures/code-review.workflow.js";
import { agent, execute, start } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

/** Everything external given: scripted models, memory stores, stubbed MCP servers. */
function offline(book: ScriptBook, stubs = new McpStubs(book)): AppOptions {
  return {
    processEnv: {},
    gateway: createScriptedGateway(book),
    connectMcp: stubbedMcpConnect(stubs, new Map(), new Set()),
  };
}

class TicketDto {
  @Text({ prompt: "the ticket" })
  text!: string;

  @Text({ prompt: "the ticket id" })
  id!: string;
}

@WorkflowStart({
  name: "ticket-workflow-start",
  description: "A helpdesk ticket",
  input: TicketDto,
})
class TicketStart {}

@Agent({
  name: "ticket-agent",
  description: "Answers tickets",
  prompt: "Answer the ticket.",
  model: "test/support",
  input: { ticket: TicketDto },
})
class TicketAgent {}

const defaults = {
  models: { temperature: 0, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 2 },
  history: { limit: 2 },
};

@Workflow({
  name: "two-starts-workflow",
  version: "1.0.0",
  flow: [
    start(TicketStart).returns(TicketDto).toAgent(TicketAgent).toFinish(Reply),
    start(ChatStart).returns(WorkflowStartTextDto).toAgent(Writer).toFinish(Reply),
  ],
  defaults,
  mcp: [NotesServer],
  providers: [OrderBook],
})
class TwoStarts {}

@Application({
  name: "two-starts-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TwoStarts],
  budgets: TEST_BUDGETS,
})
export class TwoStartsApplication {}

@Workflow({
  name: "broken-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart).returns(WorkflowStartTextDto).toAgent(Writer).toFinish(Reply),
    agent(Support).toFinish(Reply),
  ],
  defaults,
})
class Broken {}

@Application({
  name: "broken-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Broken],
  budgets: TEST_BUDGETS,
})
export class BrokenApplication {}

describe("AC12: createApp — the real app", () => {
  it("assembles before any model call and reports every assembly error at once", async () => {
    const book = new ScriptBook();

    const built = createApp(BrokenApplication, offline(book));

    await expect(built).rejects.toBeInstanceOf(GraphRuleError);
    const codes = await built.catch((error: unknown) =>
      error instanceof GraphRuleError ? error.violations.map((item) => item.code) : [],
    );
    expect(codes).toEqual(expect.arrayContaining(["graph.unreachable-node"]));
  });

  it("run returns thread, finish, output, path and spend", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("agent:coder-agent")
      .thenReturn(replyWith(CodeDto, { text: "v1" }, { cost: usd(0.002) }));
    book.scriptOf("agent:reviewer-agent").thenReturn(replyWith(ReviewDto, { text: "clean" }));
    book.scriptOf("router:review-gate-router").thenReturn(routeTo(PullRequest));
    const app = await createApp(CodeReviewApplication, offline(book));

    const result = await execute(app, TaskStart, { text: "Add a flag" });
    await app.close();

    expect(result).toMatchObject({
      finish: { name: "pull-request-workflow-finish" },
      output: { text: "v1" },
      status: ExecutionStatus.Finished,
    });
    expect(result).toFollowPath([TaskStart, Coder, Reviewer, ReviewGate, PullRequest]);
    expect(result.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.spend.totalUsd).toBeCloseTo(0.002, 9);
    expect(app.textStart).toBe(TaskStart);
    expect([app.name, app.version, app.warnings]).toEqual([
      "code-review-application",
      "1.0.0",
      [
        "[application.in-memory-cost-ledger] in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart",
      ],
    ]);
  });

  it("resume continues the paused run of a thread; a thread without a pause cannot resume", async () => {
    const book = new ScriptBook();
    const stubs = new McpStubs(book);
    stubs.stubOf("notes").thenReturn({ write_file: () => Promise.resolve({ content: "ok" }) });
    book.scriptOf("router:main-router").thenReturn(routeTo(Support));
    book
      .scriptOf("agent:support-agent")
      .thenReturn(callTool(SaveNote, { title: "a", text: "b" }), replyWith("Saved."));
    const app = await createApp(DeskApplication, offline(book, stubs));

    const paused = await execute(app, ChatStart, { text: "save a note" });
    const done = await app.resume(paused.threadId, { approved: true, by: "dana" });

    expect(paused).toMatchObject({
      status: ExecutionStatus.Paused,
      pause: { agent: "support-agent", tool: "save_note" },
    });
    expect(paused).toFollowPath([ChatStart, MainRouter, Support]);
    expect(done).toMatchObject({
      finish: { name: "reply-workflow-finish" },
      output: { text: "Saved." },
      threadId: paused.threadId,
    });
    await expect(
      app.resume(paused.threadId, { approved: true, by: "dana" }),
    ).rejects.toBeInstanceOf(NotPausedError);
    await app.close();
  });

  it("close runs onStop of the components it started, once", async () => {
    lifecycle.length = 0;
    const app = await createApp(DeskApplication, offline(new ScriptBook()));
    const started = [...lifecycle];

    await app.close();
    await app.close();

    expect(started).toEqual(["OrderBook.onStart"]);
    expect(lifecycle).toEqual(["OrderBook.onStart", "OrderBook.onStop"]);
  });

  it("checks the start and its input DTO before any call", async () => {
    const book = new ScriptBook();
    const app = await createApp(CodeReviewApplication, offline(book));

    await expect(execute(app, ChatStart, { text: "hi" })).rejects.toBeInstanceOf(
      NotAWorkflowStartError,
    );
    await expect(execute(app, Reply, { text: "hi" })).rejects.toThrow(
      'reply-workflow-finish is not a workflow start of "code-review-workflow"',
    );
    await expect(execute(app, TaskStart, { text: "" })).rejects.toBeInstanceOf(DtoValidationError);
    expect(book.scriptOf("agent:coder-agent").requests).toEqual([]);
    await app.close();
  });

  it("with several workflow starts, the run starts at the one asked for", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:ticket-agent").thenReturn(replyWith("ticket"));
    book.scriptOf("agent:writer-agent").thenReturn(replyWith("chat"));
    const app = await createApp(TwoStartsApplication, offline(book));

    const ticket = await execute(app, TicketStart, { text: "printer broken", id: "T-1" });
    const chat = await execute(app, ChatStart, { text: "hi" });
    await app.close();

    expect(ticket).toMatchObject({ output: { text: "ticket" } });
    expect(ticket).toFollowPath([TicketStart, TicketAgent, Reply]);
    expect(chat).toMatchObject({ output: { text: "chat" } });
    expect(chat).toFollowPath([ChatStart, Writer, Reply]);
    expect(app.textStart).toBe(ChatStart);
  });
});
