import { beforeEach, describe, expect, vi } from "vitest";
import { ExecutionHistoryRepository } from "../../src/infrastructure/execution-history.repository.js";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { kill, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { UndoDesk, UndoDeskError } from "../flow/runtime/fixtures/undo.workflow.js";
import {
  UnwindGate,
  unwindSeen,
  UnwindWorkflowStart,
} from "../flow/runtime/fixtures/unwind.workflow.js";
import { KeptUnwindRecoveryApplication } from "../flow/runtime/fixtures/unwind-recovery.workflow.js";

/**
 * Found by #484's scenario 12 (a crash mid-undo on PostgreSQL and SQLite pods): the instance that
 * takes a tree over mid-undo finishes the undo (#340 PR 4) and ends the tree failed — and its kept
 * record (`ExecutionHistoryRecord.compensations`, what `agboss records export` writes) must list
 * every undo action that ran, the ones of the instance that died and its own, as the
 * `onExecutionError` event does.
 */

const pair = testWith(KeptUnwindRecoveryApplication, { instances: 2 });

beforeEach(() => {
  resetRecovery();
  unwindSeen.undos.length = 0;
  unwindSeen.errors.length = 0;
});

describe("the kept record of a tree whose undo a takeover finished", () => {
  pair(
    "lists every undo action that ran, as onExecutionError does",
    async ({ apps, clock, mockOf }) => {
      const desk = mockOf(UndoDesk);
      const held = new Set(["seat-1"]);
      desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
      desk.release.mockImplementation((id: string, _key: string, signal: AbortSignal) =>
        held.delete(id)
          ? new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                reject(signal.reason as Error);
              });
            })
          : Promise.resolve(),
      );
      mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances");
      await first.ready();
      await second.ready();
      const run = execute(first, UnwindWorkflowStart, { guest: "ada" }, { threadId: "t-1" });
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
      });
      kill("instance-1");
      await clock.advance(seconds(10));
      await expect(run).rejects.toBeInstanceOf(ExecutionLeaseLostError);
      await clock.advance(seconds(21));
      await vi.waitFor(() => {
        expect(unwindSeen.errors).toHaveLength(1);
      });

      const [ended] = unwindSeen.errors;
      const names = ended?.compensations.map((record) => record.compensator.name);
      expect(names).toEqual(["release-room-action", "release-seat-action"]);
      const [kept] = await second
        .resolve(ExecutionHistoryRepository)
        .findAllByExecutionId(ended?.executionId ?? "");
      expect(kept?.status).toBe("failed");
      expect(kept?.compensations.map((record) => record.compensator.name)).toEqual(names);
    },
  );
});
