import { beforeEach, describe, expect, vi, type Mocked } from "vitest";
import {
  ApplicationStoppingError,
  CompensationFailedError,
  ExecutionLeaseLostError,
} from "../../src/index.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { Tern } from "../../src/terns/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { kill, resetRecovery, stores } from "../infrastructure/fixtures/recovery.workflow.js";
import { UndoDesk, UndoDeskError } from "../flow/runtime/fixtures/undo.workflow.js";
import {
  UnwindGate,
  UnwindParentWorkflowStart,
  unwindSeen,
  UnwindWorkflowStart,
} from "../flow/runtime/fixtures/unwind.workflow.js";
import { UnwindRecoveryApplication } from "../flow/runtime/fixtures/unwind-recovery.workflow.js";

/**
 * #340 PR 4 (AC4, S7) — the durability of the automatic undo: while a root's undo runs its record
 * stays `running` and `@agboss/unwinding` is in its tree's keys, each undo done is marked; an
 * instance that stops (`close`) or loses the lease mid-undo leaves the rest to the other instance's
 * recovery sweep, which finishes it without a pass — the undos done are not run again — and ends
 * the tree with the recorded reason. A child re-entered mid-undo finishes its own before any step.
 */

const pair = testWith(UnwindRecoveryApplication, { instances: 2 });
const single = testWith(UnwindRecoveryApplication);

const GUEST = { guest: "ada" };
const THREAD = { threadId: "t-1" };

beforeEach(() => {
  resetRecovery();
  unwindSeen.undos.length = 0;
  unwindSeen.errors.length = 0;
});

type Desk = ReturnType<typeof deskOf>;

/** The desk: reservations named by kind; each id in `held` waits, the first time, for its signal. */
function deskOf(desk: Mocked<UndoDesk>): {
  readonly desk: Mocked<UndoDesk>;
  readonly held: Set<string>;
} {
  const held = new Set<string>();
  desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
  desk.release.mockImplementation((id: string, _key: string, signal: AbortSignal) => {
    if (!held.delete(id)) return Promise.resolve();
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(signal.reason as Error);
      });
    });
  });
  return { desk, held };
}

const releasedIds = ({ desk }: Desk): unknown[] => desk.release.mock.calls.map(([id]) => id);

/** The two instances of a test, ready. */
async function both(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

/** The root's record of the thread. */
async function recordOf(): Promise<Tern | undefined> {
  const records = await stores.records?.lastTerns("default", THREAD.threadId, 5);
  return records?.[0];
}

/** A gate that waits until its step's signal aborts (a cancel), or fails at once. */
const waitsForAbort = (_guest: string, signal: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });

describe("#340 AC4: an undo interrupted on one instance is finished by the other", () => {
  pair(
    "close mid-undo: the rest is finished by the sweep, the done undo not run again",
    async ({ apps, clock, mockOf }) => {
      const desk = deskOf(mockOf(UndoDesk));
      desk.held.add("seat-1");
      mockOf(UnwindGate).wait.mockImplementation(waitsForAbort);
      const [first] = await both(apps);
      const run = execute(first, UnwindWorkflowStart, GUEST, THREAD);
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(mockOf(UnwindGate).wait.mock.calls).toHaveLength(1);
      });

      await first.cancel("t-1");
      await vi.waitFor(() => {
        expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
      });
      // S7 3: while the undo runs the root is running — what the sweep finds after a stop
      expect((await recordOf())?.status).toBe("running");
      const closed = first.close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;
      await expect(run).rejects.toBeInstanceOf(ApplicationStoppingError);
      expect(unwindSeen.errors).toEqual([]);

      await clock.advance(seconds(30));
      await vi.waitFor(() => {
        expect(unwindSeen.errors).toHaveLength(1);
      });

      expect(releasedIds(desk)).toEqual(["room-1", "seat-1", "seat-1"]);
      const [ended] = unwindSeen.errors;
      expect(ended?.error).toBeInstanceOf(ExecutionCancelledError);
      expect(ended?.compensations.map((record) => record.compensator.name)).toEqual([
        "release-room-action",
        "release-seat-action",
      ]);
      const record = await recordOf();
      expect(record?.status).toBe("failed");
      expect(record?.stopReason).toBe("the run was cancelled");
    },
  );

  pair(
    "the lease lost mid-undo: the other instance finishes the rest, ending with the recorded reason",
    async ({ apps, clock, mockOf }) => {
      const desk = deskOf(mockOf(UndoDesk));
      desk.held.add("seat-1");
      mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));
      const [first] = await both(apps);
      const run = execute(first, UnwindWorkflowStart, GUEST, THREAD);
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
      });

      kill("instance-1");
      await clock.advance(seconds(10));
      await expect(run).rejects.toBeInstanceOf(ExecutionLeaseLostError);
      expect((await recordOf())?.status).toBe("running");
      await clock.advance(seconds(21));
      await vi.waitFor(() => {
        expect(unwindSeen.errors).toHaveLength(1);
      });

      expect(releasedIds(desk)).toEqual(["room-1", "seat-1", "seat-1"]);
      const [ended] = unwindSeen.errors;
      expect(ended?.error).not.toBeInstanceOf(ExecutionCancelledError);
      expect(ended?.error.message).toContain("the gate is down");
      const record = await recordOf();
      expect(record?.status).toBe("failed");
      expect(record?.stopReason).toContain("the gate is down");
    },
  );

  pair(
    "a child re-entered mid-undo finishes its undo before any step; its parent's side path goes on",
    async ({ apps, clock, mockOf }) => {
      const desk = deskOf(mockOf(UndoDesk));
      desk.held.add("room-1");
      mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));
      const [first] = await both(apps);
      const run = execute(first, UnwindParentWorkflowStart, GUEST, THREAD);
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(releasedIds(desk)).toEqual(["room-1"]);
      });

      const closed = first.close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;
      await expect(run).rejects.toBeInstanceOf(ApplicationStoppingError);
      await clock.advance(seconds(30));
      await vi.waitFor(async () => {
        expect((await recordOf())?.status).toBe("answered");
      });

      // the child took no step again: its undo finished, then the parent's side path released the seat
      expect(mockOf(UnwindGate).wait.mock.calls).toHaveLength(1);
      expect(releasedIds(desk)).toEqual(["room-1", "room-1", "seat-1"]);
      expect(unwindSeen.errors.map((event) => event.error.name)).toEqual([
        "ChildExecutionFailedError",
      ]);
    },
  );
});

describe("#340 S7: the record after the undo, a failed undo's rejection", () => {
  single(
    "the record is running while the undo runs, then failed with CompensationFailedError",
    async ({ app, mockOf }) => {
      const desk = deskOf(mockOf(UndoDesk));
      let letGo = (): void => undefined;
      desk.desk.release.mockImplementation((id: string) =>
        id === "room-1"
          ? Promise.reject(new UndoDeskError("the room desk is down"))
          : new Promise<void>((resolve) => {
              letGo = resolve;
            }),
      );
      mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));
      const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
      });

      expect((await recordOf())?.status).toBe("running");
      letGo();

      await expect(run).rejects.toBeInstanceOf(CompensationFailedError);
      const record = await recordOf();
      expect(record?.status).toBe("failed");
      expect(record?.stopReason).toMatch(/^An automatic undo failed/);
    },
  );

  single(
    "a cancel of a running tree whose undo fails: the holder's call rejects with it (S7 1)",
    async ({ app, mockOf }) => {
      const desk = deskOf(mockOf(UndoDesk));
      desk.desk.release.mockRejectedValue(new UndoDeskError("the desk is down"));
      mockOf(UnwindGate).wait.mockImplementation(waitsForAbort);
      const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(mockOf(UnwindGate).wait.mock.calls).toHaveLength(1);
      });

      await expect(app.cancel("t-1")).resolves.toEqual({ cancelled: true });

      await expect(run).rejects.toFailWith(CompensationFailedError, {
        cause: ExecutionCancelledError,
      });
      expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    },
  );
});
