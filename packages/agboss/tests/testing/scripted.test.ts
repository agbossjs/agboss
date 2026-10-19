import { describe, expect } from "vitest";
import {
  replyWith,
  callTool,
  routeTo,
  failWith,
  ModelCallFailedError,
  ModelFailure,
  TestFailure,
  testWith,
} from "../../src/testing/index.js";
import { AgentFailedError, nameOf, RouterFailedError } from "../../src/index.js";
import { usd } from "../../src/units/index.js";
import {
  ChatStart,
  lifecycle,
  MainRouter,
  NotesServer,
  OrderStatus,
  Reply,
  SaveNote,
  Support,
  Writer,
  DeskApplication,
} from "./fixtures/desk.workflow.js";
import {
  Coder,
  PullRequest,
  CodeDto,
  ReviewDto,
  Reviewer,
  ReviewGate,
  TaskStart,
  CodeReviewApplication,
} from "./fixtures/code-review.workflow.js";
import { toolResultsOf } from "./fixtures/requests.js";
import { execute, answerOf } from "../helpers/flow.js";

const test = testWith(DeskApplication);
const review = testWith(CodeReviewApplication);
const approve = { approved: true };

describe("AC12: scripted models — answers, tool calls, decisions by script", () => {
  test("an agent answers and calls a tool by script; the router decides by script", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(callTool(OrderStatus, { orderId: "42" }), replyWith("Shipped."));

    const result = await execute(app, ChatStart, { text: "Where is order 42?" });

    expect(result).toFollowPath([ChatStart, MainRouter, Support, Reply]);
    expect(result).toFinishWith(Reply, { text: "Shipped." });
    expect(mockLlm(Support)).toHaveCalledTools([OrderStatus]);
    expect(toolResultsOf(mockLlm(Support).lastRequest)).toEqual(['{"status":"order 42 shipped"}']);
  });

  review(
    "the code-review cycle: the gate sends the code back to the coder twice",
    async ({ app, mockLlm }) => {
      mockLlm(Coder).thenReturn(
        replyWith(CodeDto, { text: "v1" }),
        replyWith(CodeDto, { text: "v2" }),
        replyWith(CodeDto, { text: "v3" }),
      );
      mockLlm(Reviewer).thenReturn(
        replyWith(ReviewDto, { text: "fix A" }),
        replyWith(ReviewDto, { text: "fix B" }),
        replyWith(ReviewDto, { text: "clean" }),
      );
      mockLlm(ReviewGate).thenReturn(routeTo(Coder), routeTo(Coder), routeTo(PullRequest));

      const result = await execute(app, TaskStart, { text: "Add a flag" });

      const lap = [Coder, Reviewer, ReviewGate];
      expect(result).toFollowPath([TaskStart, ...lap, ...lap, ...lap, PullRequest]);
      expect(result).toFinishWith(PullRequest, { text: "v3" });
    },
  );

  test("thenReturnAlways answers every call after the scripted turns", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturnAlways(routeTo(Writer));
    mockLlm(MainRouter).thenReturn(routeTo(Writer), routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("first")).thenReturnAlways(replyWith("again"));

    const first = await execute(app, ChatStart, { text: "hi" });
    const second = await execute(
      app,
      ChatStart,
      { text: "hi again" },
      { threadId: first.threadId },
    );

    expect(first.output).toEqual({ text: "first" });
    expect(second.output).toEqual({ text: "again" });
  });

  test("failWith: a router's failed call fails the run at the router", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(failWith(ModelFailure.Timeout));

    await expect(execute(app, ChatStart, { text: "hi" })).rejects.toFailWith(RouterFailedError, {
      nodeId: nameOf(MainRouter),
      cause: ModelCallFailedError,
    });
  });

  test("failWith: an agent's failed call fails the run at the agent", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer));
    mockLlm(Writer).thenReturn(failWith(ModelFailure.RateLimited));

    await expect(execute(app, ChatStart, { text: "hi" })).rejects.toFailWith(AgentFailedError, {
      agent: nameOf(Writer),
      cause: ModelCallFailedError,
    });
  });

  test("a script shorter than the run fails clearly, naming the class", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer), routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("only one"));
    const first = await execute(app, ChatStart, { text: "hi" });

    const run = execute(app, ChatStart, { text: "hi" }, { threadId: first.threadId });

    await expect(run).rejects.toFailWith(TestFailure, { code: "test.script-exhausted" });
    await expect(run).rejects.toThrow(/script exhausted for Writer: 1 turn scripted, asked for #2/);
  });

  test("routeTo(X) for a node that is not among the router's routes fails the test", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ChatStart));

    await expect(execute(app, ChatStart, { text: "hi" })).rejects.toThrow(
      /test.not-a-route: routeTo\(chat-workflow-start\) for MainRouter: not one of its routes \(no-reply-workflow-finish, support-agent, writer-agent\)/,
    );
  });

  test("a scripted cost is the run's spend", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer, { cost: usd(0.001) }));
    mockLlm(Writer).thenReturn(replyWith("hi", { cost: usd(0.002), truncated: true }));

    const result = await execute(app, ChatStart, { text: "hi" });

    expect(result.spend.totalUsd).toBeCloseTo(0.003, 9);
    expect(result.spend.byCaller).toMatchObject({ "router:main-router": 0.001 });
  });
});

describe("AC12: scripts are picked by position, so a resumed run continues the script", () => {
  test("a run paused in one app and resumed after recoverApp() continues the same script", async ({
    app,
    recoverApp,
    mockLlm,
    mcpOf,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(
      callTool(SaveNote, { title: "n1", text: "call back" }),
      replyWith("Saved."),
    );
    const notes = mcpOf(NotesServer).thenReturn({
      write_file: () => Promise.resolve({ content: "ok" }),
    });

    const paused = await execute(app, ChatStart, { text: "note: call back" });
    const restarted = await recoverApp();
    const done = await restarted.resume(answerOf(paused, approve));

    expect(paused).toHavePausedAt(Support);
    expect(done).toFinishWith(Reply, { text: "Saved." });
    expect(done).toFollowPath([ChatStart, MainRouter, Support, Reply]);
    expect(notes.calls.map((call) => call.tool)).toEqual(["write_file"]);
    expect(mockLlm(MainRouter).requests).toHaveLength(1);
  });
});

describe("#148 AC4: recoverApp() closes the current app and returns a new one over the same state", () => {
  test("onStop runs on restart; the new app keeps the ids and the ledger going", async ({
    app,
    recoverApp,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer, { cost: usd(0.001) }), routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("one"), replyWith("two"));
    await app.tool(OrderStatus).invoke({ orderId: "1" });
    const first = await execute(app, ChatStart, { text: "1" });
    lifecycle.length = 0;

    const restarted = await recoverApp();
    const second = await execute(restarted, ChatStart, { text: "2" });

    expect(lifecycle).toEqual(["OrderBook.onStop", "OrderBook.onStart"]);
    expect([first.threadId, second.threadId]).toEqual(["thread-1", "thread-2"]);
    expect(second.output).toEqual({ text: "two" });
  });

  test("the old app fails with test.app-closed after a restart", async ({ app, recoverApp }) => {
    await recoverApp();

    await expect(execute(app, ChatStart, { text: "hi" })).rejects.toFailWith(TestFailure, {
      code: "test.app-closed",
    });
    await expect(app.tool(OrderStatus).invoke({ orderId: "1" })).rejects.toThrow(
      /test.app-closed: this app is closed/,
    );
  });

  test("recoverApp() twice: each restart closes the app returned before", async ({
    recoverApp,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("third"));

    const second = await recoverApp();
    const third = await recoverApp();

    await expect(execute(second, ChatStart, { text: "hi" })).rejects.toFailWith(TestFailure, {
      code: "test.app-closed",
    });
    expect((await execute(third, ChatStart, { text: "hi" })).output).toEqual({ text: "third" });
  });
});
