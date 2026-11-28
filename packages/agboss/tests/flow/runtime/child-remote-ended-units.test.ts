/**
 * #1356 (mutation shard `once-child`): the parent's wait for a remote child's row — a claim that won the race against
 * the parent's give-up is read again at once (the row, now running, is told to the reclaimers), never after a sleep.
 */
import { describe, expect, it, vi } from "vitest";
import { ChildPlacement } from "../../../src/flow/child-placement.js";
import { remoteChildSignals } from "../../../src/flow/runtime/remote/remote-child-signals.js";
import { remoteChildEndOf } from "../../../src/flow/runtime/remote/remote-child.js";
import { ExecutionRecordStatus } from "../../../src/infrastructure/execution-record.repository.js";

const mocks = vi.hoisted(() => ({ lostToClaim: vi.fn() }));
vi.mock("../../../src/flow/runtime/remote/remote-claim.js", () => ({
  lostToClaim: mocks.lostToClaim,
  rowOf: vi.fn(),
}));
vi.mock("../../../src/flow/runtime/child-thread.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/runtime/child-thread.js")>()),
  atLeafCheckpoint: vi.fn(() => Promise.resolve({})),
  asRootRun: <T>(body: () => Promise<T>) => body(),
  rootConfigOf: (config: unknown) => config,
}));

describe("#1286: the wait for a remote child's row", () => {
  it("a claim that won the race is read again at once: the running row is told, no sleep is taken", async () => {
    const rows = [
      { status: ExecutionRecordStatus.Queued },
      { status: ExecutionRecordStatus.Running },
      { status: ExecutionRecordStatus.Answered },
    ];
    const find = vi.fn(() => Promise.resolve(rows.shift()));
    const sleep = vi.fn(() => Promise.resolve());
    mocks.lostToClaim.mockResolvedValueOnce(true).mockResolvedValue(false);
    const running = vi.spyOn(remoteChildSignals, "running");
    const graph = { checkpointer: {}, getState: () => Promise.resolve({ values: {} }) };
    const site = {
      children: {
        queue: { findByTenantIdAndExecutionId: find },
        clock: { sleep },
        yieldWhile: undefined,
        claimTimeout: 5000,
      },
      tenantId: "acme",
      executionId: "child-1",
      placement: ChildPlacement.OtherWorker,
      signal: new AbortController().signal,
      run: { thread: "t/child/child-1", initial: { child: { inheritedUsage: 0 } } },
    };

    const end = await remoteChildEndOf(graph as never, {} as never, site as never, undefined);

    expect(end).toMatchObject({ failed: false });
    expect(sleep).not.toHaveBeenCalled();
    expect(running).toHaveBeenCalledWith({ status: ExecutionRecordStatus.Running });
    running.mockRestore();
  });
});
