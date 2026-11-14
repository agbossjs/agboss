import { ExecutionRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import { ExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { UNWINDING_KEY } from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { processHoldPoints } from "../../../src/testing/faults/hold-points.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { logged, resetLogged } from "../../helpers/log.js";
import { resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import { unwindSeen } from "../../flow/runtime/fixtures/unwind.workflow.js";
import { resetFencedEffect } from "./fenced-effect.workflow.js";
import { instance } from "./fence-takeover.js";
import { resetYield } from "./remote-child-yield.workflow.js";
import { resetHung } from "./lease-scope-bound.application.js";

/** #928 lease scopes — what the lease-scope tests share. */

export const GUEST = { guest: "ada" };
export const THREAD = { threadId: "t-1" };

/** The state every lease-scope test starts from. */
export function resetScopeBound(): void {
  resetHung();
  resetFencedEffect();
  resetRecovery();
  resetYield();
  resetLogged();
  unwindSeen.undos.length = 0;
  unwindSeen.errors.length = 0;
}

/** The end of every lease-scope test: no hold left. */
export const releaseHolds = (): void => {
  processHoldPoints.releaseAll();
};

/** Both instances of the test, ready. */
export async function ready(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  return [a, b];
}

/** The root's record of the thread, and whether the tree still keeps `@agboss/unwinding`. */
export async function rootOf(app: TestApp): Promise<{ status: string; isUnwinding: boolean }> {
  const [record] = await app.resolve(ExecutionRecordRepository).lastTurns("default", "t-1", 1);
  if (record === undefined) throw new Error("the thread has no record");
  const mark = await app
    .resolve(ExecutionTreeRepository)
    .findByIdInTree({ tenantId: "default", rootExecutionId: record.runId ?? "" }, UNWINDING_KEY);
  return { status: record.status, isUnwinding: mark !== undefined };
}

/** What a call did so far: settled, and with what. */
export function trackOf(call: Promise<unknown>): { isSettled: boolean; error: unknown } {
  const state = { isSettled: false, error: undefined as unknown };
  void call.then(
    () => {
      state.isSettled = true;
    },
    (error: unknown) => {
      state.isSettled = true;
      state.error = error;
    },
  );
  return state;
}

/** How many `store.call-timeout` entries the log holds. */
export const timeoutLogs = (): number =>
  logged.filter((entry) => entry.code === "store.call-timeout").length;
