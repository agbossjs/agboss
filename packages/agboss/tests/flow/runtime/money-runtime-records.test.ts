/**
 * #1366 (money-runtime shard) — what a child's record keeps of what its failure carried (its tool calls and steps),
 * a question role's runner that loads on its first visit only, and the key a pass lost to a takeover is kept under.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChildExecutionStatus } from "../../../src/flow/runtime/child-records.js";
import { childRecordOf } from "../../../src/flow/runtime/child-exit.js";
import { LOST_PASSES_KEY } from "../../../src/flow/runtime/lost-pass-records.js";
import { lazyQuestionRunner } from "../../../src/flow/runtime/node-runner.js";
import { questionRunner } from "../../../src/flow/runtime/runners/question.js";

vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  recordOfNode: vi.fn((_records: unknown, id: string) => ({ node: id })),
}));
vi.mock("../../../src/flow/runtime/runners/question.js", () => ({ questionRunner: vi.fn() }));

const child = {
  identity: {
    executionId: "child-1",
    parentExecutionId: "p",
    rootExecutionId: "r",
    inheritedUsage: 0,
  },
  depth: 1,
  workflow: { name: "w" },
  launchedBy: { kind: "x" },
  start: "start",
  input: { in: 1 },
  records: {},
} as never;
const carried = {
  toolCalls: [{ carried: "tool" }],
  judgeVerdicts: [],
  guardrailDecisions: [],
  steps: [{ carried: "step" }],
} as never;
const ended = (carriedRecords?: object) => ({
  status: ChildExecutionStatus.Failed,
  usage: [],
  ...(carriedRecords === undefined ? {} : { carried: carriedRecords }),
});

describe("#1366: the records a child that ended keeps", () => {
  it("a child with no state keeps what its failure carried, and no path or children", () => {
    const record = childRecordOf(child, undefined, ended(carried) as never);

    expect(record).toMatchObject({
      path: [],
      children: [],
      toolCalls: [{ carried: "tool" }],
      steps: [{ carried: "step" }],
    });
  });

  it("a child with a state keeps its own, then what its failure carried of the visit that failed", () => {
    const state = {
      path: ["start", "agent"],
      toolCalls: [{ own: "tool" }],
      stepRecords: [{ own: "step" }],
      children: [{ own: "child" }],
    } as never;

    const record = childRecordOf(child, state, ended(carried) as never);

    expect(record).toMatchObject({
      path: ["start", "agent"],
      toolCalls: [{ own: "tool" }, { carried: "tool" }],
      steps: [{ own: "step" }, { carried: "step" }],
      children: [{ own: "child" }],
    });
  });

  it("a failure that carried nothing adds nothing", () => {
    const state = {
      path: [],
      toolCalls: [{ own: "tool" }],
      stepRecords: [],
      children: [],
    } as never;

    expect(childRecordOf(child, state, ended() as never)).toMatchObject({
      toolCalls: [{ own: "tool" }],
      steps: [],
    });
    expect(childRecordOf(child, undefined, ended() as never)).toMatchObject({
      toolCalls: [],
      steps: [],
    });
  });
});

describe("#1366: a question role's runner", () => {
  beforeEach(() => {
    vi.mocked(questionRunner).mockReset();
  });

  it("is made on its first visit and no sooner, once, and every visit runs it", async () => {
    const run = vi.fn((_state: unknown, _config: unknown) => Promise.resolve({ ran: true }));
    vi.mocked(questionRunner).mockReturnValue(run as never);
    const node = { id: "ask" } as never;
    const deps = { deps: true } as never;
    const budgets = { budgets: true } as never;

    const lazy = lazyQuestionRunner(node, deps, budgets);
    expect(questionRunner).not.toHaveBeenCalled();
    const first = await lazy({ visit: 1 } as never, { c: 1 } as never);
    const second = await lazy({ visit: 2 } as never, undefined);

    expect(first).toEqual({ ran: true });
    expect(second).toEqual({ ran: true });
    expect(questionRunner).toHaveBeenCalledExactlyOnceWith(node, deps, budgets);
    expect(run).toHaveBeenNthCalledWith(1, { visit: 1 }, { c: 1 });
    expect(run).toHaveBeenNthCalledWith(2, { visit: 2 }, undefined);
  });
});

describe("#1366: the lost passes' key", () => {
  it("is the one the state keeps them under: a recovery reads it by this name", () => {
    expect(LOST_PASSES_KEY).toBe("agbossLostPasses");
  });
});
