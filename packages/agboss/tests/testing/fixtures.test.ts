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

describe("AC12: mockOf — a typed mock injected instead of the class", () => {
  test("the app's tool gets the mock; mockOf returns the same instance the app uses", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(OrderBook).statusOf.mockResolvedValue("order lost");
    mockLlm(MainRouter).thenReturn(routeTo(Support));
    mockLlm(Support).thenReturn(callTool(OrderStatus, { orderId: "7" }), replyWith("Lost."));

    await execute(app, ChatStart, { text: "where is 7?" });

    expect(mockOf(OrderBook).statusOf.mock.calls).toEqual([["7"]]);
    expect(toolResultsOf(mockLlm(Support).lastRequest)).toEqual(['{"status":"order lost"}']);
  });

  review("mockOf of a class the workflow does not use fails clearly", ({ mockOf }) => {
    expect(() => mockOf(Unused)).toThrow(TestSetupError);
    expect(() => mockOf(Unused)).toThrow("mockOf(Unused): not a component of this application");
  });

  test("mockOf after the app started fails clearly", async ({ app, mockOf }) => {
    await app.tool(OrderStatus).invoke({ orderId: "1" });

    expect(() => mockOf(OrderBook)).toThrow(/mockOf\(OrderBook\) after the app started/);
  });
});

describe("AC12: mockLlm — what a component sent its model", () => {
  test("onlyRequest and lastRequest; toHaveBeenAskedWith matches parts", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer));
    mockLlm(Writer).thenReturn(replyWith("Hello!"));

    await execute(app, ChatStart, { text: "say hello" });

    expect(mockLlm(Writer).onlyRequest).toMatchObject({
      kind: "chat",
      system: expect.stringContaining("You write short replies.") as string,
    });
    expect(mockLlm(Writer)).toHaveBeenAskedWith({ input: "say hello" });
    expect(mockLlm(MainRouter).lastRequest).toMatchObject({
      kind: "decision",
      options: ["no-reply-workflow-finish", "support-agent", "writer-agent"],
    });
    expect(mockLlm(MainRouter)).toHaveBeenAskedWith({ instructions: "Pick who handles" });
  });

  test("onlyRequest fails unless there was exactly one; lastRequest fails with none", ({
    mockLlm,
  }) => {
    expect(() => mockLlm(Writer).onlyRequest).toThrow(
      "mockLlm(Writer).onlyRequest: expected exactly one request, got 0",
    );
    expect(() => mockLlm(Writer).lastRequest).toThrow("mockLlm(Writer): no request was sent");
  });

  review(
    "mockLlm of a class that is not an agent or router of the workflow fails",
    ({ mockLlm }) => {
      expect(() => mockLlm(Unused)).toThrow(
        "mockLlm(Unused): not an agent, router, judge, model arbiter, model reply interpreter, PII detection or guardrail of this application",
      );
      expect(() => mockLlm(Writer)).toThrow(TestSetupError);
    },
  );
});

describe("AC12: slices — one component of the real app on its own", () => {
  test("app.tool(X) runs the tool with its real dependencies", async ({ app }) => {
    expect(await app.tool(OrderStatus).invoke({ orderId: "9" })).toEqual({
      kind: "ok",
      value: { status: "order 9 shipped" },
    });
  });

  test("app.router(X) decides on a text and returns the chosen node", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(Writer));

    expect(await app.router(MainRouter).routeTo("write a reply")).toBe(Writer);
    expect(mockLlm(MainRouter).onlyRequest).toMatchObject({ input: "write a reply" });
  });

  test("app.agent(X) answers a task with its own model, prompt and tools", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Support).thenReturn(
      callTool(OrderStatus, { orderId: "3" }),
      replyWith("Order 3 shipped."),
    );

    expect(await app.agent(Support).replyWith("where is 3?")).toBe("Order 3 shipped.");
    expect(mockLlm(Support)).toHaveCalledTools([OrderStatus]);
  });

  test("a slice of something the workflow does not have fails clearly", async ({ app }) => {
    await expect(app.router(Writer).routeTo("x")).rejects.toThrow(
      "app.router(Writer): not a router of this application",
    );
    await expect(app.agent(MainRouter).replyWith("x")).rejects.toThrow(
      "app.agent(MainRouter): not an agent of this application",
    );
  });

  test("app.router(X) fails like the flow when its model fails", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(failWith(ModelFailure.ServerError));

    await expect(app.router(MainRouter).routeTo("x")).rejects.toFailWith(RouterFailedError, {
      nodeId: nameOf(MainRouter),
      cause: ModelCallFailedError,
    });
  });
});
