/**
 * #662 — an action runs only while its holder holds the tree. The holder is held in the action's
 * `onActionStart` after its last lease renewal while its lease store and timers are frozen; another
 * instance takes the tree over and runs the action; then the old holder goes on. It must not run
 * the action again: the undo a side path runs (a refund paid twice else), and a charge on the main
 * path. Its call rejects with `ExecutionLeaseLostError`.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError, type Class } from "../../src/index.js";
import {
  testWith,
  type TestApp,
  type TestLeases,
  type VirtualClock,
} from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { readyAll } from "./fixtures/child-end-freeze.js";
import { resetEndOnce } from "./fixtures/child-end-once.workflow.js";
import { resetMatrix } from "./fixtures/end-once-matrix.workflow.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import { resetUndo, undoSeen } from "./fixtures/finished-undo.workflow.js";
import { openGate, resetYield } from "./fixtures/remote-child-yield.workflow.js";
import {
  ActionFenceApplication,
  actionGate,
  armActionGate,
  ChargeWorkflowStart,
  SideUndoWorkflowStart,
} from "./fixtures/action-fence.application.js";

const test = testWith(ActionFenceApplication, { instances: 2 });

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetUndo();
  resetMatrix();
  resetLogged();
});

/** The action's run on the old holder held in its `onActionStart`; the tree taken over; let go. */
async function heldPastItsLease(
  run: {
    readonly apps: readonly TestApp[];
    readonly clock: VirtualClock;
    readonly leases: TestLeases;
  },
  site: { readonly start: Class; readonly outcome: string; readonly action: string },
  isDone: () => boolean,
): Promise<{ readonly error: unknown; readonly old: string | undefined }> {
  const { apps, clock, leases } = run;
  const [a] = apps;
  if (a === undefined) throw new Error("two instances");
  const byId = await readyAll(apps);
  const old = [...byId].find(([, each]) => each === a)?.[0];
  armActionGate(site.action);
  openGate();
  const call = rejectionOf(
    execute(a, site.start, item("gate", site.outcome === "fail" ? "fail" : "ok"), {
      threadId: "t",
    }),
  );
  await until(() => actionGate.held.length === 1, `the old holder held in ${site.action}`);
  leases.stall(a);
  for (let step = 0; step < 24 && !isDone(); step += 1) {
    await clock.advance(seconds(10));
    await settle();
  }
  await until(isDone, "the new holder ran the action");
  await settle();
  actionGate.release();
  leases.resume(a);
  const error = await call;
  await settle();
  return { error, old };
}

describe("#662: a holder held in an action's onActionStart past its lease runs nothing", () => {
  test("a side path's undo: refunded once, by the new holder", async ({ apps, clock, leases }) => {
    const run = { apps, clock, leases };
    const site = { start: SideUndoWorkflowStart, outcome: "fail", action: "cancel-booking-action" };
    const { error, old } = await heldPastItsLease(run, site, () => undoSeen.cancelled.length > 0);

    expect(actionGate.held).toEqual([old]);
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(undoSeen.cancelled).toHaveLength(1);
    expect(undoSeen.cancelled[0]).not.toContain(old ?? "unknown");
  });

  test("a charge on the main path: charged once, by the new holder", async ({
    apps,
    clock,
    leases,
  }) => {
    const run = { apps, clock, leases };
    const site = { start: ChargeWorkflowStart, outcome: "ok", action: "charge-item-action" };
    const { error, old } = await heldPastItsLease(run, site, () => actionGate.charged.length > 0);

    expect(actionGate.held).toEqual([old]);
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(actionGate.charged).toHaveLength(1);
    expect(actionGate.charged[0]).not.toContain(old ?? "unknown");
  });
});
