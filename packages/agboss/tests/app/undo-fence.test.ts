/**
 * #605 — an undo runs only while its holder still holds the tree. The holder's step is held at its
 * gate (a dependency that does not answer) while its lease store and timers are frozen; another
 * instance takes the tree over and runs the same step, which waits at the same gate. The gate opens:
 * both steps fail. Before the fix the old holder, past its lease but its expiry timer not fired
 * yet, went on to undo what the new holder undid too — a refund paid twice. Now it stops at its own
 * fence right before the undo action (`assertHeld`, #533): a hand-over, no undo.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import { readyAll } from "./fixtures/child-end-freeze.js";
import { endOnceSeen, resetEndOnce } from "./fixtures/child-end-once.workflow.js";
import { UndoLocalWorkflowStart } from "./fixtures/child-failure-once.workflow.js";
import { resetUndo, UndoChildWorkflowStart, undoSeen } from "./fixtures/finished-undo.workflow.js";
import { JoinUndoWorkflowStart } from "./fixtures/join-undo.workflow.js";
import {
  EndOnceMatrixApplication,
  resetMatrix,
  takeoversSeen,
} from "./fixtures/end-once-matrix.workflow.js";
import { openGate, resetYield, yieldSeen } from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(EndOnceMatrixApplication, { instances: 2 });

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetUndo();
  resetMatrix();
  resetLogged();
});

/** The root's failures heard (the child workflow run as a root counts among the children there). */
const rootFailures = () => endOnceSeen.errors.filter((each) => each.executionId === "execution-1");

const UNDOS = [
  { undo: "a child's undo", start: UndoLocalWorkflowStart },
  { undo: "a root's own undo", start: UndoChildWorkflowStart },
  { undo: "a failed join's undo", start: JoinUndoWorkflowStart },
] as const;

describe("#605 AC1: a holder that lost the tree while its step ran undoes nothing", () => {
  for (const { undo, start } of UNDOS)
    test(`${undo}: run once, by the new holder — the old one's call rejects with ExecutionLeaseLostError`, async ({
      apps,
      clock,
      leases,
    }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      const byId = await readyAll(apps);
      const old = [...byId].find(([, each]) => each === a)?.[0];
      const call = rejectionOf(execute(a, start, item("gate", "fail"), { threadId: "thread-u" }));
      await until(() => yieldSeen.runs.length === 1, "the old holder's step at its gate");
      leases.stall(a);
      const isTakenOver = (): boolean =>
        takeoversSeen.some((each) => each.previous === old && each.holder !== old);
      for (let step = 0; step < 12 && !isTakenOver(); step += 1) await clock.advance(seconds(10));
      await until(() => yieldSeen.runs.length === 2, "the new holder's step at the same gate");
      // both steps fail now; the old holder's lease timers are still frozen
      openGate();
      for (let step = 0; step < 12 && rootFailures().length === 0; step += 1)
        await clock.advance(seconds(10));
      await until(() => rootFailures().length > 0, "the tree failed where it was taken over");
      await settle();
      leases.resume(a);
      const error = await call;
      await settle();

      expect(isTakenOver()).toBe(true);
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(undoSeen.booked).toHaveLength(1);
      expect(undoSeen.cancelled).toHaveLength(1);
      expect(undoSeen.cancelled[0]).not.toContain(old ?? "unknown");
      expect(rootFailures()).toHaveLength(1);
      expect(rootFailures()[0]?.instanceId).not.toBe(old);
    });
});
