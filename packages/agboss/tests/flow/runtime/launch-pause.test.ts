import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { execute, answerOf } from "../../helpers/flow.js";
import {
  ClerkApplication,
  ConfirmItemTool,
  ItemClerkAgent,
} from "./fixtures/launch-runs.workflow.js";
import {
  ItemResultDto,
  ItemsWorkflowStart,
  SummaryWorkflowFinish,
  type ItemDto,
} from "./fixtures/fan-out.workflow.js";

/**
 * #273 S20 (#267 AC1): a branch that pauses frees its slot — its siblings start and finish in the
 * same superstep — and on resume only the paused branch goes on; the join then gives every value.
 */

const clerks = testWith(ClerkApplication);
const approve = { approved: true };

const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });
const SIX = ["a", "b", "c", "d", "e", "f"].map(item);

/** The item a request is about, by its name in the input message. */
const itemOf = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return SIX.find((candidate) => input.includes(`"name": "${candidate.name}"`))?.name ?? "?";
};

/** `b` asks for a confirmation first; everyone answers with their item's name. */
const clerk = (request: ModelRequest) => {
  const name = itemOf(request);
  const confirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return name === "b" && !confirmed
    ? callTool(ConfirmItemTool, { name })
    : replyWith(ItemResultDto, { name });
};

describe("S20: a pause inside a branch", () => {
  clerks(
    "a paused branch frees its slot: with maxConcurrency 2 every sibling finishes",
    async ({ app, mockLlm }) => {
      mockLlm(ItemClerkAgent).thenAnswer(clerk);

      const paused = await execute(app, ItemsWorkflowStart, SIX);

      expect(paused.status).toBe(ExecutionStatus.Paused);
      expect(paused.pending).toMatchObject([
        { agent: "item-clerk-agent", itemIndex: 1, ask: { tool: "confirm-item-tool" } },
      ]);
      const asked = mockLlm(ItemClerkAgent).requests.map(itemOf);
      expect([...asked].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    },
  );

  clerks(
    "on resume only the paused branch goes on; the join gives every value in order",
    async ({ app, mockLlm }) => {
      mockLlm(ItemClerkAgent).thenAnswer(clerk);
      const paused = await execute(app, ItemsWorkflowStart, SIX);
      const before = mockLlm(ItemClerkAgent).requests.length;

      const done = await app.resume(answerOf(paused, approve));

      expect(done).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c, d, e, f" });
      expect(mockLlm(ItemClerkAgent).requests.slice(before).map(itemOf)).toEqual(["b"]);
      expect(done.launches).toMatchObject([{ items: 6, taken: 6 }]);
    },
  );
});
