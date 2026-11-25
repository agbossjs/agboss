import { describe, expect } from "vitest";
import {
  replyWith,
  callTool,
  routeTo,
  failWith,
  ModelCallFailedError,
  ModelFailure,
  TestSetupError,
  testWith,
} from "../../src/testing/index.js";
import { nameOf, RouterFailedError } from "../../src/index.js";
import {
  ChatStart,
  MainRouter,
  OrderBook,
  OrderStatus,
  Reply,
  Support,
  Writer,
  DeskApplication,
} from "./fixtures/desk.workflow.js";
import { Unused, CodeReviewApplication } from "./fixtures/code-review.workflow.js";
import { toolResultsOf } from "./fixtures/requests.js";
import { execute } from "../helpers/flow.js";

const test = testWith(DeskApplication);
const review = testWith(CodeReviewApplication);

describe("AC12: mockService — a typed mock injected instead of the class", () => {
  test("the app's tool gets the mock; mockService returns the same instance the app uses", async ({
    app,
    mockModel,
    mockService,
  }) => {
    mockService(OrderBook).statusOf.mockResolvedValue("order lost");
    mockModel(MainRouter).thenReturn(routeTo(Support));
    mockModel(Support).thenReturn(callTool(OrderStatus, { orderId: "7" }), replyWith("Lost."));

    await execute(app, ChatStart, { text: "where is 7?" });

    expect(mockService(OrderBook).statusOf.mock.calls).toEqual([["7"]]);
    expect(toolResultsOf(mockModel(Support).lastRequest)).toEqual(['{"status":"order lost"}']);
  });

  review("mockService of a class the workflow does not use fails clearly", ({ mockService }) => {
    expect(() => mockService(Unused)).toThrow(TestSetupError);
    expect(() => mockService(Unused)).toThrow(
      "mockService(Unused): not a component of this application",
    );
  });

  test("mockService after the app started fails clearly", async ({ app, mockService }) => {
    await app.runTool(OrderStatus, { orderId: "1" });

    expect(() => mockService(OrderBook)).toThrow(/mockService\(OrderBook\) after the app started/);
  });
});

describe("AC12: mockModel — what a component sent its model", () => {
  test("onlyRequest and lastRequest; toHaveBeenAskedWith matches parts", async ({
    app,
    mockModel,
  }) => {
    mockModel(MainRouter).thenReturn(routeTo(Writer));
    mockModel(Writer).thenReturn(replyWith("Hello!"));

    await execute(app, ChatStart, { text: "say hello" });

    expect(mockModel(Writer).onlyRequest).toMatchObject({
      kind: "chat",
      system: expect.stringContaining("You write short replies.") as string,
    });
    expect(mockModel(Writer)).toHaveBeenAskedWith({ input: "say hello" });
    expect(mockModel(MainRouter).lastRequest).toMatchObject({
      kind: "decision",
      options: ["no-reply-workflow-finish", "support-agent", "writer-agent"],
    });
    expect(mockModel(MainRouter)).toHaveBeenAskedWith({ instructions: "Pick who handles" });
  });

  test("onlyRequest fails unless there was exactly one; lastRequest fails with none", ({
    mockModel,
  }) => {
    expect(() => mockModel(Writer).onlyRequest).toThrow(
      "mockModel(Writer).onlyRequest: expected exactly one request, got 0",
    );
    expect(() => mockModel(Writer).lastRequest).toThrow("mockModel(Writer): no request was sent");
  });

  review(
    "mockModel of a class that is not an agent or router of the workflow fails",
    ({ mockModel }) => {
      expect(() => mockModel(Unused)).toThrow(
        "mockModel(Unused): not an agent, router, judge, model arbiter, model reply interpreter, PII detection, guardrail or compaction that writes summaries of this application",
      );
      expect(() => mockModel(Writer)).toThrow(TestSetupError);
    },
  );
});

describe("AC12: slices — one component of the real app on its own", () => {
  test("app.runTool(X, …) runs the tool with its real dependencies", async ({ app }) => {
    expect((await app.runTool(OrderStatus, { orderId: "9" })).output).toEqual({
      kind: "ok",
      value: { status: "order 9 shipped" },
    });
  });

  test("app.runRouter(X, …) decides on a text and returns the chosen node", async ({
    app,
    mockModel,
  }) => {
    mockModel(MainRouter).thenReturn(routeTo(Writer));

    expect((await app.runRouter(MainRouter, "write a reply")).output).toBe(Writer);
    expect(mockModel(MainRouter).onlyRequest).toMatchObject({ input: "write a reply" });
  });

  test("app.runAgent(X, …) answers a task with its own model, prompt and tools", async ({
    app,
    mockModel,
  }) => {
    mockModel(Support).thenReturn(
      callTool(OrderStatus, { orderId: "3" }),
      replyWith("Order 3 shipped."),
    );

    expect((await app.runAgent(Support, "where is 3?")).output).toBe("Order 3 shipped.");
    expect(mockModel(Support)).toHaveScriptedToolCalls([OrderStatus]);
  });

  test("a slice of something the workflow does not have fails clearly", async ({ app }) => {
    await expect(app.runRouter(Writer, "x")).rejects.toThrow(
      "app.runRouter(Writer): not a router of this application",
    );
    await expect(app.runAgent(MainRouter, "x")).rejects.toThrow(
      "app.runAgent(MainRouter): not an agent of this application",
    );
  });

  test("app.runRouter(X, …) fails like the flow when its model fails", async ({
    app,
    mockModel,
  }) => {
    mockModel(MainRouter).thenReturn(failWith(ModelFailure.ServerError));

    await expect(app.runRouter(MainRouter, "x")).rejects.toFailWith(RouterFailedError, {
      nodeId: nameOf(MainRouter),
      cause: ModelCallFailedError,
    });
  });
});
