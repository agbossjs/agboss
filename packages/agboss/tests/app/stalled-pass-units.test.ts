/**
 * #1098 / #1179 (recovery shard) — `stalledPassOf`, on its own: the pass of a tree a resume took the
 * lease of and found no answer to take. Only a tree whose record runs and of which nothing waits was
 * left mid-pass; a tree that waits at an open pause is where it is — whatever its record says — and a
 * record that does not run is read. With the late mark fenced (#1179) the waiting check is reached
 * only by a `running` record at a rest that a refused resume left, so it is pinned here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stalledPassOf } from "../../src/app/recovery-pass.js";
import type { TreeState } from "../../src/app/tree-move-types.js";

const mocks = vi.hoisted(() => ({ waiting: vi.fn(), continueAgent: vi.fn() }));
vi.mock("../../src/run/waiting-pauses.js", () => ({ waitingInterruptsOf: mocks.waiting }));
vi.mock("../../src/run/run-budgets.js", () => ({ readingGraphOf: () => ({}) }));
vi.mock("../../src/run/continue-agent.js", () => ({ continueAgent: mocks.continueAgent }));
vi.mock("../../src/app/live-runs.js", () => ({ runOptionsOf: () => ({}) }));

const state: TreeState = {
  runId: "root-1",
  threadId: "thread-1",
  tenantId: "acme",
  startedVersion: "1.0.0",
};
const call = { signal: new AbortController().signal } as never;

const depsWith = (status: string) =>
  ({
    turns: { findByTenantIdAndRunId: vi.fn(() => Promise.resolve({ id: "tern-1", status })) },
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.waiting.mockResolvedValue([]);
  mocks.continueAgent.mockResolvedValue(undefined);
});

describe("#1098: the pass of a tree left mid-pass", () => {
  it("a running record, nothing waiting: the tree is continued from its checkpoint", async () => {
    const pass = await stalledPassOf(depsWith("running"), state, call);

    expect(pass).toBeDefined();
    await pass?.pass({} as never, undefined as never);
    expect(mocks.continueAgent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "root-1", turnId: "tern-1" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("a running record at an open pause (a resume refused after its mark left it so): no pass, it is read", async () => {
    mocks.waiting.mockResolvedValue([{ pauseId: "pause-2" }]);

    expect(await stalledPassOf(depsWith("running"), state, call)).toBeUndefined();
    expect(mocks.continueAgent).not.toHaveBeenCalled();
  });

  it.each(["paused", "answered", "failed"])("a %s record: no pass", async (status) => {
    expect(await stalledPassOf(depsWith(status), state, call)).toBeUndefined();
    expect(mocks.waiting).not.toHaveBeenCalled();
  });
});
