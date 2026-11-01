import { expect, vi } from "vitest";
import { ExecutionHistoryRepository } from "../../../src/infrastructure/execution-history.repository.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import { unwindSeen } from "../../flow/runtime/fixtures/unwind.workflow.js";

/** #635 — what the kept-record tests share: the guest, the undos as listed, the checks. */

export const GUEST = { guest: "ada" };
export const THREAD = { threadId: "t-1" };
export const ROOM = "release-room-action compensated";
export const SEAT = "release-seat-action compensated";

/** A wait that holds until its step's signal aborts. */
export const heldUntilAborted = (_guest: string, signal: AbortSignal): Promise<void> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });

/** The undos the root's error event lists; its kept record (with `status`) lists the same. */
export async function keptAsTheEvent(app: TestApp, status: string): Promise<readonly string[]> {
  const roots = () => unwindSeen.errors.filter((error) => error.parentExecutionId === undefined);
  await vi.waitFor(() => {
    expect(roots()).toHaveLength(1);
  });
  const [ended] = roots();
  const event = (ended?.compensations ?? []).map(
    (undo) => `${undo.compensator.name} ${undo.status}`,
  );
  const kept = await app
    .resolve(ExecutionHistoryRepository)
    .findAllByExecutionId(ended?.executionId ?? "");
  expect(kept.map((record) => record.status)).toEqual([status]);
  expect(kept[0]?.compensations.map((undo) => `${undo.compensator.name} ${undo.status}`)).toEqual(
    event,
  );
  return event;
}

export function resetKeptUndo(): void {
  resetRecovery();
  unwindSeen.undos.length = 0;
  unwindSeen.errors.length = 0;
}
