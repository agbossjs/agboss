import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { ChildExecutionStatus } from "../../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { ItemResultDto, type ItemDto } from "./fixtures/fan-out.workflow.js";
import {
  ChildrenApplication,
  childLog,
  ConfirmReviewTool,
  ItemReviewedWorkflowFinish,
  ItemReviewerAgent,
  resetChildLog,
  ReviewItemsWorkflowStart,
  ReviewOneWorkflowStart,
  ReviewsSummaryWorkflowFinish,
} from "./fixtures/children.workflow.js";

/**
 * #263 PR 2 — pauses inside children: AC16 (a paused child does not stop its siblings; the
 * execution pauses only when nothing else can move) and S24 (a child keeps its id across
 * a pause: no second `onExecutionStart`).
 */

const test = testWith(ChildrenApplication);
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };
const approve = { approved: true, by: "dana" };
/** The answer to the one pause a paused execution lists (a thread owner's: its id is listed). */
const answerOf = (paused: { readonly pending: readonly { readonly pauseId?: string }[] }) => ({
  pauseId: paused.pending[0]?.pauseId ?? "",
  decision: approve,
});
const TEN = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });

const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

/** `b` asks for a confirmation first; every review answers with its item's name. */
const reviewer = (request: ModelRequest) => {
  const name = nameIn(request);
  const confirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return name === "b" && !confirmed
    ? callTool(ConfirmReviewTool, { name })
    : replyWith(ItemResultDto, { name });
};

const childStarts = (): readonly string[] =>
  childLog.starts
    .filter((event) => event.workflow.name === "item-review-workflow")
    .map((event) => event.executionId);

beforeEach(resetChildLog);

describe("AC16: a paused child does not stop its siblings", () => {
  test("one child of ten pauses with maxConcurrency 2: every sibling finishes first", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);

    const paused = await execute(app, ReviewItemsWorkflowStart, TEN.map(item), who);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toMatchObject([
      { agent: "item-reviewer-agent", itemIndex: 1, ask: { tool: "confirm-review-tool" } },
    ]);
    const asked = mockLlm(ItemReviewerAgent).requests.map(nameIn);
    expect([...new Set(asked)].sort()).toEqual(TEN);
    expect(childStarts()).toHaveLength(10);
  });

  test("on resume only the paused child goes on, with its id; the join gives every value", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
    const paused = await execute(app, ReviewItemsWorkflowStart, TEN.map(item), who);
    const before = mockLlm(ItemReviewerAgent).requests.length;
    const started = childStarts();

    const done = await app.resume(answerOf(paused), { tenantId: "acme" });

    expect(done).toFinishWith(ReviewsSummaryWorkflowFinish, { text: TEN.join(", ") });
    expect(mockLlm(ItemReviewerAgent).requests.slice(before).map(nameIn)).toEqual(["b"]);
    // no second onExecutionStart: the resumed child kept the id it started with
    expect(childStarts()).toEqual(started);
    expect([...done.children.map((child) => child.executionId)].sort()).toEqual(
      [...started].sort(),
    );
    expect(done.children.every((child) => child.status === ChildExecutionStatus.Finished)).toBe(
      true,
    );
  });
});
