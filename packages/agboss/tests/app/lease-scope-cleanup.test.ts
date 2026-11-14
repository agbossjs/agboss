/**
 * #928 AC1 lease scopes — the cleanup after the terminal record stays outside the scope: an
 * unanswered forgetTree, kept record or audit row is an ordinary store error at 15 s, never a
 * hand-over (a hand-over there would delete `@agboss/unwinding` or release a lease too early).
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError, StoreCallTimeoutError } from "../../src/index.js";
import { testWith, type WorkflowFixtures } from "../../src/testing/index.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { logged } from "../helpers/log.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { passLive } from "../helpers/live-time.js";
import { UndoDesk, UndoDeskError } from "../flow/runtime/fixtures/undo.workflow.js";
import { UnwindGate, UnwindWorkflowStart } from "../flow/runtime/fixtures/unwind.workflow.js";
import { ChargeWorkflowStart, book } from "./fixtures/fenced-effect.workflow.js";
import { LeaseScopeAuditApplication } from "./fixtures/lease-scope-audit.application.js";
import {
  callsOf,
  hangNext,
  LeaseScopeBoundApplication,
} from "./fixtures/lease-scope-bound.application.js";
import {
  GUEST,
  ready,
  releaseHolds,
  resetScopeBound,
  rootOf,
  THREAD,
  timeoutLogs,
  trackOf,
} from "./fixtures/lease-scope-bound.helpers.js";

const two = testWith(LeaseScopeBoundApplication, { instances: 2 });

beforeEach(resetScopeBound);
afterEach(releaseHolds);

describe("#928 AC1 lease scopes: the cleanup after the terminal record stays outside", () => {
  const name =
    "post-terminal forgetTree / keepExecutionRecord / audit held for ever: unleased, 15 s, no hand-over";

  /** A failing run whose terminal record is written; `hold` then holds one call of its cleanup. */
  async function heldCleanup(
    { apps, clock, mockOf }: Pick<WorkflowFixtures, "apps" | "clock" | "mockOf">,
    hold: () => void,
    isHeld: () => boolean,
  ) {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));
    const [a, b] = await ready(apps);
    hold();
    const run = trackOf(execute(a, UnwindWorkflowStart, GUEST, THREAD));
    await until(isHeld, "the cleanup's call is held");
    await passLive(clock, seconds(14));
    expect(run.isSettled).toBe(false);
    await passLive(clock, seconds(2));
    await until(() => run.isSettled, "the call ends at its bound");
    return { run, b };
  }

  const unleased = (): string | undefined =>
    logged.find((entry) => entry.code === "store.call-timeout")?.message;

  two(`${name} (forgetTree)`, async ({ apps, clock, mockOf }) => {
    const { run, b } = await heldCleanup(
      { apps, clock, mockOf },
      () => {
        hangNext("trees.deleteAllInTree");
      },
      () => callsOf("trees.deleteAllInTree") > 0,
    );

    // an ordinary store error at 15 s, the pass's lease released as at any end: no hand-over
    expect(run.error).toBeInstanceOf(StoreCallTimeoutError);
    expect(unleased()).toContain("unleased call");
    expect((await rootOf(b)).status).toBe("failed");
  });

  two(`${name} (keepExecutionRecord)`, async ({ apps, clock, mockOf }) => {
    const { run, b } = await heldCleanup(
      { apps, clock, mockOf },
      () => {
        processHoldPoints.arm({ point: StoreHoldPoint.HistorySave });
      },
      () => processHoldPoints.held.length > 0,
    );

    // the kept record is best effort: the run ends with its own failure, not a hand-over, and the
    // keys are forgotten after it
    expect(run.error).not.toBeInstanceOf(ExecutionLeaseLostError);
    expect(unleased()).toContain("unleased call");
    expect(callsOf("trees.deleteAllInTree")).toBeGreaterThan(0);
    expect(await rootOf(b)).toEqual({ status: "failed", isUnwinding: false });
  });
});

const single = testWith(LeaseScopeAuditApplication);

describe("#928 AC1 lease scopes: an audit row", () => {
  single(
    "post-terminal forgetTree / keepExecutionRecord / audit held for ever: unleased, 15 s, no hand-over (audit)",
    async ({ app, clock }) => {
      hangNext("audit.save");
      const call = trackOf(execute(app, ChargeWorkflowStart, { text: "order-3" }));
      await until(() => callsOf("audit.save") > 0, "the audit row is held");

      await passLive(clock, seconds(16));
      await until(() => call.isSettled, "the run ends");

      // the row's own 15 s bound, never a hand-over of the step it records: the charge went through
      expect(call.error).toBeUndefined();
      expect(book.charges).toHaveLength(1);
      expect(timeoutLogs()).toBeGreaterThan(0);
    },
  );
});
