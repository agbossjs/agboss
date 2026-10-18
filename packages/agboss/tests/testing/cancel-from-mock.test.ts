/**
 * #262 PR 2 — AC14: a cancellation from inside a mock ends the execution with
 * `ExecutionCancelledError`, the real way: the mocked service calls `app.cancel(threadId)`.
 */
import { describe, expect } from "vitest";
import { ExecutionCancelledError } from "../../src/index.js";
import { callTool, routeTo, testWith } from "../../src/testing/index.js";
import {
  ChatStart,
  DeskApplication,
  MainRouter,
  OrderBook,
  OrderStatus,
  Support,
} from "./fixtures/desk.workflow.js";
import { execute } from "../helpers/flow.js";

const desk = testWith(DeskApplication);

describe("AC14: app.cancel from inside a mock", () => {
  desk(
    "the service cancels while the tool runs: the execution is cancelled",
    async ({ app, mockLlm, mockOf }) => {
      // a test's thread ids are deterministic: its first execution runs on thread-1
      const threadId = "thread-1";
      mockOf(OrderBook).statusOf.mockImplementation(async () => {
        await app.cancel(threadId);
        return "order 7 shipped";
      });
      mockLlm(MainRouter).thenReturn(routeTo(Support));
      // cancelled during the tool call: the agent's model is never asked again
      mockLlm(Support).thenReturn(callTool(OrderStatus, { orderId: "7" }));

      const run = execute(app, ChatStart, { text: "where is 7?" });

      await expect(run).rejects.toFailWith(ExecutionCancelledError);
      expect(mockOf(OrderBook).statusOf.mock.calls).toEqual([["7"]]);
    },
  );
});
