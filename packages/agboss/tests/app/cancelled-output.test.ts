import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { cancelCauseOf, cancelledOutputOf } from "../../src/app/cancelled-output.js";
import { historyRestOf } from "../../src/app/execution-history.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { ExecutionHistoryStatus } from "../../src/infrastructure/execution-history.repository.js";
import { usd } from "../../src/units/index.js";

const mocks = vi.hoisted(() => ({ state: vi.fn() }));

vi.mock("../../src/app/execution-history.js", async (original) => ({
  ...(await original<typeof import("../../src/app/execution-history.js")>()),
  checkpointStateOf: mocks.state,
}));

const STATE = { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "1" };
const CAUSE = new ExecutionCancelledError({ message: 'thread "thread-1" was cancelled' });

const EMPTY = {
  path: [],
  usage: [],
  launches: [],
  children: [],
  handledErrors: [],
  compensations: [],
  toolCalls: [],
};

const warn = vi.fn();
const deps = { log: { warn }, config: { name: "cancelled-workflow" } } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1341: the cancelled output of a tree", () => {
  it("reports what its checkpoint holds: path, spend, children, launches, tool calls", async () => {
    mocks.state.mockResolvedValue({
      path: ["start", "agent"],
      usage: [],
      launches: [],
      children: [],
      handledErrors: [],
      compensations: [],
      toolCalls: [],
    });

    const output = await cancelledOutputOf(deps, STATE, { cause: CAUSE });

    expect(output).toMatchObject({
      status: ExecutionStatus.Cancelled,
      threadId: "thread-1",
      tenantId: "acme",
      executionId: "root-1",
      path: ["start", "agent"],
      pending: [],
      compensations: [],
    });
    expect(output.spend.totalUsd).toBe(usd(0));
    expect(output.finish).toBeUndefined();
    expect(output.output).toBeUndefined();
  });

  it("lists the undo the end ran, not the checkpoint's: what ran outside the checkpoint (#635)", async () => {
    mocks.state.mockResolvedValue(EMPTY);
    const ran = [{ compensator: { name: "release" } }] as never;

    const output = await cancelledOutputOf(deps, STATE, { cause: CAUSE, compensations: ran });

    expect(output.compensations).toBe(ran);
  });

  it("remembers the cancel it was built for: its record and its pauses' end read it", async () => {
    mocks.state.mockResolvedValue(EMPTY);

    const output = await cancelledOutputOf(deps, STATE, { cause: CAUSE });

    expect(cancelCauseOf(output)).toBe(CAUSE);
    expect(cancelCauseOf({ ...output })).toBeUndefined();
  });

  it("a checkpoint that cannot be read never turns the cancel into a rejection: a warning, an empty report", async () => {
    mocks.state.mockRejectedValue(new Error("store down"));

    const output = await cancelledOutputOf(deps, STATE, { cause: CAUSE });

    expect(output).toMatchObject({ status: ExecutionStatus.Cancelled, path: [], children: [] });
    expect(output.spend.totalUsd).toBe(usd(0));
    expect(warn).toHaveBeenCalledWith(
      "execution.cancelled-checkpoint-unread",
      expect.stringContaining("store down"),
      { executionId: "root-1", tenantId: "acme" },
    );
  });
});

describe("#1341: how a pass that returned is kept in the history", () => {
  it.each([
    [ExecutionStatus.Finished, ExecutionHistoryStatus.Finished],
    [ExecutionStatus.Paused, ExecutionHistoryStatus.Paused],
    [ExecutionStatus.Stopped, ExecutionHistoryStatus.Stopped],
    [ExecutionStatus.Cancelled, ExecutionHistoryStatus.Cancelled],
  ])("%s is kept as %s", (status, kept) => {
    expect(historyRestOf(status)).toEqual({ status: kept });
  });

  it("every status has a history status: a new one cannot be kept as another", () => {
    const kept = Object.values(ExecutionStatus).map((status) => historyRestOf(status).status);

    expect(new Set(kept).size).toBe(Object.values(ExecutionStatus).length);
  });
});
