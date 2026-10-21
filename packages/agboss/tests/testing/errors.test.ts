/**
 * #262 PR 2 — errors caused the real way (AC10): a failed model call (`failWith`), a rejecting mock,
 * a scripted tool failure (`mockTool(…).thenFail(ToolFailure.Timeout)`); the testing API creates no
 * framework error; `rejects.toFailWith(ErrorClass, { …fields, cause })` matches through the cause
 * chain.
 */
import { describe, expect, it } from "vitest";
import { ActionFailedError, AGBossError, RouterFailedError, nameOf } from "../../src/index.js";
import * as testing from "../../src/testing/index.js";
import {
  callTool,
  failWith,
  ModelCallFailedError,
  ModelFailure,
  replyWith,
  routeTo,
  testWith,
  ToolFailure,
} from "../../src/testing/index.js";
import {
  CarrierError,
  OrderWorkflowStart,
  ShipOrderAction,
} from "../flow/fixtures/order.fixture.js";
import {
  ChatStart,
  DeskApplication,
  MainRouter,
  OrderStatus,
  Support,
  Writer,
} from "./fixtures/desk.workflow.js";
import { OrderApplication } from "./fixtures/order.application.js";
import { toolResultsOf } from "./fixtures/requests.js";
import { execute } from "../helpers/flow.js";

const desk = testWith(DeskApplication);
const orders = testWith(OrderApplication);

describe("AC10: only real causes", () => {
  desk("failWith: the router's model call fails, its error the cause", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(failWith(ModelFailure.Timeout));

    const run = execute(app, ChatStart, { text: "hi" });

    await expect(run).rejects.toFailWith(RouterFailedError, {
      nodeId: nameOf(MainRouter),
      cause: ModelCallFailedError,
    });
    await expect(run).rejects.toFailWith(ModelCallFailedError, { failure: ModelFailure.Timeout });
  });

  orders(
    "a rejecting mock: the action's step fails with it as the cause",
    async ({ app, mockOf }) => {
      mockOf(ShipOrderAction).execute.mockRejectedValue(new TypeError("no carrier for this zone"));

      const run = app.execute(OrderWorkflowStart, { orderId: "9" });

      await expect(run).rejects.toFailWith(ActionFailedError, {
        nodeId: nameOf(ShipOrderAction),
        cause: TypeError,
      });
      await expect(run).rejects.toFailWith(TypeError, { message: "no carrier for this zone" });
      await expect(run).rejects.not.toFailWith(CarrierError);
    },
  );

  desk(
    "mockTool(…).thenFail(ToolFailure.Timeout): the agent reads the timeout; the next call runs the tool",
    async ({ app, mockLlm, mockTool }) => {
      mockTool(OrderStatus).thenFail(ToolFailure.Timeout);
      mockLlm(MainRouter).thenReturn(routeTo(Support));
      mockLlm(Support).thenReturn(
        callTool(OrderStatus, { orderId: "7" }),
        callTool(OrderStatus, { orderId: "7" }),
        replyWith("Shipped, after a retry."),
      );

      await execute(app, ChatStart, { text: "where is 7?" });

      expect(toolResultsOf(mockLlm(Support).lastRequest)).toEqual([
        expect.stringContaining("timed out after 30 s"),
        '{"status":"order 7 shipped"}',
      ]);
    },
  );

  desk.fails(
    "a scripted tool failure never caused fails the test at its end",
    async ({ app, mockLlm, mockTool }) => {
      mockTool(OrderStatus).thenFail(ToolFailure.Timeout);
      mockLlm(MainRouter).thenReturn(routeTo(Writer));
      mockLlm(Writer).thenReturn(replyWith("no tool needed"));

      expect((await execute(app, ChatStart, { text: "hi" })).output).toEqual({
        text: "no tool needed",
      });
    },
  );

  desk(
    "mockTool of a class that is not a tool of the application fails the setup",
    ({ mockTool }) => {
      expect(() => mockTool(Writer)).toThrow("mockTool(Writer): not a tool of this application");
    },
  );

  it("agboss/testing exports no framework error to throw by name", () => {
    const exported: readonly unknown[] = Object.values(testing);
    const frameworkErrors = exported.filter(
      (value) => typeof value === "function" && value.prototype instanceof AGBossError,
    );

    expect(frameworkErrors).toEqual([]);
  });
});

describe("AC10: toFailWith through the cause chain", () => {
  orders("the class, a subclass's parent, the fields, the cause", async ({ app, mockOf }) => {
    mockOf(ShipOrderAction).execute.mockRejectedValue(new RangeError("weight over the limit"));

    const run = app.execute(OrderWorkflowStart, { orderId: "10" });

    await expect(run).rejects.toFailWith(AGBossError, { code: "step.action" });
    await expect(run).rejects.toFailWith(ActionFailedError, { visitNumber: 1, cause: RangeError });
    await expect(run).rejects.toFailWith(RangeError);
    await expect(run).rejects.not.toFailWith(ActionFailedError, { nodeId: "reserve-stock-action" });
    await expect(run).rejects.not.toFailWith(ActionFailedError, { cause: CarrierError });
  });
});
