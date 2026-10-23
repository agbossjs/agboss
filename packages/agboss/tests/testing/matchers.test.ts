import { describe, expect, it } from "vitest";
import { bareRecordOf, ComponentKind } from "../../src/flow/runtime/records.js";
import { ExecutionStatus, type ExecutionOutput } from "../../src/app/types.js";
import { buildCostReport } from "../../src/finops/usage.js";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import {
  GraphRuleError,
  LimitExceededError,
  nameOf,
  RouterDecisionError,
  RouterFailedError,
} from "../../src/index.js";
import { replyWith, callTool, routeTo, TestFailure, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChatStart,
  MainRouter,
  OrderStatus,
  ReadNote,
  Reply,
  Support,
  Writer,
  DeskApplication,
} from "./fixtures/desk.workflow.js";

const PATH = ["chat-workflow-start", "main-router", "writer-agent", "reply-workflow-finish"];

const run = (parts: Partial<ExecutionOutput>): ExecutionOutput => ({
  threadId: "thread-1",
  tenantId: "default",
  executionId: "run-1",
  status: ExecutionStatus.Finished,
  path: PATH,
  spend: buildCostReport([]),
  launches: [],
  children: [],
  handledErrors: [],
  compensations: [],
  toolCalls: [],
  finish: bareRecordOf("reply-workflow-finish", ComponentKind.WorkflowFinish),
  output: { text: "Hi." },
  pending: [],
  ...parts,
});

const paused = run({
  status: ExecutionStatus.Paused,
  path: ["chat-workflow-start", "main-router", "support-agent"],
  finish: undefined,
  output: undefined,
  pending: [
    {
      pauseId: "pause-1",
      answeredBy: PauseAnswerer.ThreadOwner,
      agent: "support-agent",
      channel: "terminal-user-channel",
      childExecutionId: undefined,
      itemIndex: undefined,
      ask: { callId: "call-1", tool: "save-note-tool", arguments: {}, summary: "save a note" },
    },
  ],
});

describe("AC12: matchers by class — a passing and a failing case, readable failures", () => {
  it("toFollowPath compares the visited nodes in order", () => {
    expect(run({})).toFollowPath([ChatStart, MainRouter, Writer, Reply]);
    expect(run({})).not.toFollowPath([ChatStart, MainRouter, Support, Reply]);
    expect(() => {
      expect(run({})).toFollowPath([ChatStart, MainRouter, Support]);
    }).toThrow(
      "expected the path chat-workflow-start → main-router → support-agent, it was chat-workflow-start → main-router → writer-agent → reply-workflow-finish",
    );
  });

  it("toFinishWith names the finish class and its data", () => {
    expect(run({})).toFinishWith(Reply);
    expect(run({})).toFinishWith(Reply, { text: "Hi." });
    expect(() => {
      expect(run({})).toFinishWith(Reply, { text: "Bye." });
    }).toThrow(
      'expected the run to finish at reply-workflow-finish with {"text":"Bye."}, it finished at "reply-workflow-finish" with {"text":"Hi."}',
    );
    expect(() => {
      expect(paused).toFinishWith(Reply);
    }).toThrow('expected the run to finish at reply-workflow-finish, it paused at "support-agent"');
  });

  it("toHavePausedAt names the agent the run waits in", () => {
    expect(paused).toHavePausedAt(Support);
    expect(() => {
      expect(paused).toHavePausedAt(Writer);
    }).toThrow('expected the run to pause at writer-agent, it paused at "support-agent"');
    expect(() => {
      expect(run({ finish: undefined })).toHavePausedAt(Writer);
    }).toThrow("it ended finished without a finish");
  });

  it("toFailWith matches a class and its fields along the cause chain (#262 AC10)", () => {
    const router = new RouterDecisionError(
      { nodeId: "main-router", visitNumber: 1 },
      '"ghost-agent" is not one of its routes',
    );
    const limit = new LimitExceededError(
      { key: "maxSteps", limit: 1, actual: 2 },
      ["writer-agent"],
      2,
    );
    const agent = new AgentFailedError(
      "writer-agent",
      [],
      new TestFailure("test.script-exhausted", "x"),
    );
    const rules = new GraphRuleError([
      { code: "graph.unreachable-node", message: "x", nodes: ["writer-agent"] },
    ]);

    expect(router).toFailWith(RouterDecisionError, { nodeId: "main-router" });
    expect(router).toFailWith(RouterFailedError, { code: "step.router.invalid-decision" });
    expect(limit).toFailWith(LimitExceededError, { key: "maxSteps" });
    expect(agent).toFailWith(AgentFailedError, { agent: "writer-agent", cause: TestFailure });
    expect(agent).toFailWith(TestFailure, { code: "test.script-exhausted" });
    expect(rules).toFailWith(GraphRuleError, {
      violations: [{ code: "graph.unreachable-node", nodes: [nameOf(Writer)] }],
    });
    expect(router).not.toFailWith(AgentFailedError);
    expect(() => {
      expect(router).toFailWith(RouterFailedError, { nodeId: "writer-agent" });
    }).toThrow(
      'expected a failure RouterFailedError with {"nodeId":"writer-agent"} (or one it was caused by), got RouterDecisionError: Router "main-router" decided wrongly: "ghost-agent" is not one of its routes',
    );
    expect(() => {
      expect(agent).toFailWith(AgentFailedError, { cause: RouterFailedError });
    }).toThrow("got AgentFailedError");
    expect(() => {
      expect("no error").toFailWith(Error);
    }).toThrow("expected a failure Error (or one it was caused by), got no error");
  });

  it("the run matchers want a run result", () => {
    expect(() => {
      expect({}).toFollowPath([]);
    }).toThrow("toFollowPath: expected a run result (app.execute / app.resume)");
    expect(() => {
      expect({}).toFinishWith(Reply);
    }).toThrow("toFinishWith: expected a run result");
    expect(() => {
      expect({}).toHavePausedAt(Support);
    }).toThrow("toHavePausedAt: expected a run result");
    expect(() => {
      expect(run({})).toHaveCalledTools([]);
    }).toThrow("toHaveCalledTools: expected mockLlm(…) of an agent or a router");
    expect(() => {
      expect(run({})).toHaveBeenAskedWith({});
    }).toThrow("toHaveBeenAskedWith: expected mockLlm(…)");
  });
});

const test = testWith(DeskApplication);

describe("AC12: matchers on mockLlm(…)", () => {
  test("toHaveCalledTools and toHaveBeenAskedWith name the class", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(callTool(OrderStatus, { orderId: "5" }), replyWith("Shipped."));

    await execute(app, ChatStart, { text: "where is 5?" });

    expect(mockLlm(Support)).toHaveCalledTools([OrderStatus]);
    expect(mockLlm(Writer)).toHaveCalledTools([]);
    expect(() => {
      expect(mockLlm(Support)).toHaveCalledTools([ReadNote]);
    }).toThrow("expected Support to call read-note-tool, it called order-status-tool");
    expect(mockLlm(Support)).toHaveBeenAskedWith({ kind: "chat", input: "where is 5?" });
    expect(mockLlm(Support)).not.toHaveBeenAskedWith({ input: "where is 6?" });
    expect(() => {
      expect(mockLlm(Writer)).toHaveBeenAskedWith({ input: "x" });
    }).toThrow('expected Writer to be asked with {"input":"x"}, its requests: []');
  });
});
