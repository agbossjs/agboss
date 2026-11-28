/**
 * #1341c — the wake of a parked root an `app.unpause` died on (`wakeParkedOf`), on its own: only a
 * `paused` record, only while the lease row carries no freeze and the checkpoint waits at no pause
 * (both read before any lease is taken: a frozen tree and a business rest cost no write), only under
 * the tree's lease (a held lease is its holder's), the freeze asked again once the lease is held —
 * then the record is marked `running` by compare-and-set from `paused` with the `Unpause` history row,
 * the lease given back in every case.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { wakeParkedOf } from "../../src/app/answered-wake.js";
import { LeaseTakeoverReason } from "../../src/infrastructure/execution-audit-log.repository.js";
import type { LeaseTake } from "../../src/app/execution-leases.js";
import type { TreeMoveParts } from "../../src/app/tree-move-types.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { runningOutcome } from "../../src/run/execute.js";
import { StatusTrigger, ThreadStatus, type Turn } from "../../src/turns/index.js";
import { usd } from "../../src/units/index.js";

const mocks = vi.hoisted(() => ({ pauses: vi.fn() }));

const recordOf = (status: string, runId: string | null = "root-1"): Turn =>
  ({
    id: "turn-1",
    runId,
    threadId: "thread-1",
    tenantId: "acme",
    status,
    configVersion: "1.0.0",
    route: ["step"],
    costUsd: usd(0.25),
  }) as never;

function partsOf(
  options: {
    readonly marks?: readonly object[];
    readonly isHeld?: boolean;
    readonly now?: string;
    readonly history?: readonly object[];
    readonly isWithoutPauses?: boolean;
    readonly isGone?: boolean;
  } = {},
) {
  const takes: LeaseTake[] = [];
  const released = vi.fn(() => Promise.resolve());
  const completeIfStatus = vi.fn(() => Promise.resolve(true));
  const marks = [...(options.marks ?? [{}])];
  const tryHold = vi.fn((_tree: unknown, take: LeaseTake) => {
    takes.push(take);
    return Promise.resolve(options.isHeld === true ? undefined : { release: released });
  });
  const byIds = vi.fn((_ids: string[]) =>
    Promise.resolve(
      options.isGone === true ? [] : [recordOf(options.now ?? ExecutionRecordStatus.Paused)],
    ),
  );
  const statusHistory = vi.fn((_tenantId: string, _threadId: string) =>
    Promise.resolve(options.history ?? [{ toStatus: "externally-paused" }]),
  );
  const parts: Pick<TreeMoveParts, "deps" | "leases"> = {
    deps: {
      config: { version: "2.0.0" },
      pause:
        options.isWithoutPauses === true
          ? undefined
          : { pauses: { findAllByTenantIdAndRootExecutionId: mocks.pauses } },
      turns: {
        statusHistory: () =>
          Promise.resolve(options.history ?? [{ toStatus: "externally-paused" }]),
        completeIfStatus,
        byIds,
      },
    } as never,
    leases: {
      pauseOf: () => Promise.resolve(marks.length > 1 ? marks.shift() : marks[0]),
      tryHold,
    } as never,
  };
  const records = { statusHistory } as never;
  return { parts, records, takes, released, completeIfStatus, tryHold, byIds, statusHistory };
}

beforeEach(() => {
  mocks.pauses.mockReset();
  mocks.pauses.mockResolvedValue([{ status: "taken" }, { status: "cancelled" }]);
});

describe("#1341c: the wake of a parked root", () => {
  it("a parked orphan — paused, unfrozen, waiting at no pause — is marked running from the record under its lease, with the Unpause history row", async () => {
    const { parts, records, completeIfStatus, released, takes } = partsOf();

    expect(await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused))).toBe(true);

    expect(completeIfStatus).toHaveBeenCalledWith(
      "turn-1",
      ExecutionRecordStatus.Paused,
      runningOutcome(["step"], usd(0.25)),
      { toStatus: ThreadStatus.Running, trigger: StatusTrigger.Unpause },
    );
    expect(released).toHaveBeenCalledOnce();
    // a take that is over once the record moved: the holder's lease is not taken for nothing
    expect(await takes[0]?.isOver?.()).toBe(false);
  });

  it("a record that is not paused, or has no run: nothing is read, no lease taken", async () => {
    const running = partsOf();
    const noRun = partsOf();

    expect(
      await wakeParkedOf(running.parts, running.records)(recordOf(ExecutionRecordStatus.Running)),
    ).toBe(false);
    expect(
      await wakeParkedOf(noRun.parts, noRun.records)(recordOf(ExecutionRecordStatus.Paused, null)),
    ).toBe(false);

    expect(running.tryHold).not.toHaveBeenCalled();
    expect(noRun.tryHold).not.toHaveBeenCalled();
  });

  it("frozen by an operator (the mark is the database's), or waiting at a business pause: skipped before any lease is taken", async () => {
    const frozen = partsOf({ marks: [{ pause: { mode: "after-step" } }] });
    const business = partsOf();
    mocks.pauses.mockResolvedValue([{ status: "pending" }]);

    expect(
      await wakeParkedOf(frozen.parts, frozen.records)(recordOf(ExecutionRecordStatus.Paused)),
    ).toBe(false);
    expect(
      await wakeParkedOf(business.parts, business.records)(recordOf(ExecutionRecordStatus.Paused)),
    ).toBe(false);

    expect(frozen.tryHold).not.toHaveBeenCalled();
    expect(business.tryHold).not.toHaveBeenCalled();
    expect(frozen.completeIfStatus).not.toHaveBeenCalled();
  });

  it("a paused record the history does not show parked — a business rest whose pause rows are gone, a restarted application's — is not woken", async () => {
    const { parts, records, tryHold } = partsOf({
      history: [{ toStatus: "paused", trigger: "ask" }],
    });

    expect(await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused))).toBe(false);
    expect(tryHold).not.toHaveBeenCalled();
  });

  it("a thread whose last change is the lift of a pause (an unpause that died) is woken", async () => {
    const { parts, records, completeIfStatus } = partsOf({
      history: [{ toStatus: "running", trigger: "unpause" }],
    });

    expect(await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused))).toBe(true);
    expect(completeIfStatus).toHaveBeenCalledOnce();
  });

  it("a lease held elsewhere is its holder's: nothing marked", async () => {
    const { parts, records, completeIfStatus } = partsOf({ isHeld: true });

    expect(await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused))).toBe(false);
    expect(completeIfStatus).not.toHaveBeenCalled();
  });

  it("a pause that came while the lease was being taken is seen under it: nothing marked, the lease given back", async () => {
    const { parts, records, completeIfStatus, released } = partsOf({
      marks: [{}, { pause: { mode: "immediate" } }],
    });

    expect(await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused))).toBe(false);

    expect(completeIfStatus).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
  });

  it("the take is over once the record moved on; a record another holder moved meanwhile is not marked", async () => {
    const moved = partsOf({ now: ExecutionRecordStatus.Running });
    moved.completeIfStatus.mockResolvedValueOnce(false);

    expect(
      await wakeParkedOf(moved.parts, moved.records)(recordOf(ExecutionRecordStatus.Paused)),
    ).toBe(false);
    expect(await moved.takes[0]?.isOver?.()).toBe(true);
    expect(moved.released).toHaveBeenCalledOnce();
  });

  it("a pause answered and waiting to be taken (resolved) is a business rest too: not woken, no lease taken", async () => {
    const { parts, records, tryHold } = partsOf();
    mocks.pauses.mockResolvedValue([{ status: "taken" }, { status: "resolved" }]);

    expect(await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused))).toBe(false);
    expect(tryHold).not.toHaveBeenCalled();
  });

  it("an application with no pause stores has no business rest to read: the root is woken by its history alone", async () => {
    const { parts, records, completeIfStatus } = partsOf({ isWithoutPauses: true });

    expect(await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused))).toBe(true);
    expect(completeIfStatus).toHaveBeenCalledOnce();
  });

  it("only the thread's last change counts, and a thread with none is not woken", async () => {
    const none = partsOf({ history: [] });
    const lifted = partsOf({
      history: [{ toStatus: "running" }, { toStatus: "paused" }, { trigger: "unpause" }],
    });
    const liftedBefore = partsOf({
      history: [{ trigger: "unpause" }, { toStatus: "running" }, { toStatus: "paused" }],
    });

    expect(
      await wakeParkedOf(none.parts, none.records)(recordOf(ExecutionRecordStatus.Paused)),
    ).toBe(false);
    expect(
      await wakeParkedOf(lifted.parts, lifted.records)(recordOf(ExecutionRecordStatus.Paused)),
    ).toBe(true);
    expect(
      await wakeParkedOf(
        liftedBefore.parts,
        liftedBefore.records,
      )(recordOf(ExecutionRecordStatus.Paused)),
    ).toBe(false);
    expect(none.tryHold).not.toHaveBeenCalled();
  });

  it("is taken as a takeover for the recovery, of the tree the record's run names", async () => {
    const { parts, records, tryHold, takes, byIds, statusHistory } = partsOf({ isGone: true });

    await wakeParkedOf(parts, records)(recordOf(ExecutionRecordStatus.Paused));

    // the pauses and the history are read for the tree and the thread of the record
    expect(mocks.pauses).toHaveBeenCalledWith("acme", "root-1");
    expect(statusHistory).toHaveBeenCalledWith("acme", "thread-1");

    expect(tryHold).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "root-1" },
      expect.anything(),
    );
    expect(takes[0]).toMatchObject({ reason: LeaseTakeoverReason.Recovered, isTakeover: true });
    // a record gone (its tree's end removed it) is over too
    expect(await takes[0]?.isOver?.()).toBe(true);
    expect(byIds).toHaveBeenCalledWith(["turn-1"]);
  });
});
