/**
 * #605 / #640 — an undo runs only while its holder holds the tree, checked where it counts. The old
 * holder is held after its last lease renewal — at the read of its undo's done mark (#607), in the
 * undo's `onCompensationStart`, or in its undo action's `onActionStart` (an observer, or the PII mask
 * of an event with `detectWithModel`, taking long) — while its lease store and timers are frozen.
 * Another instance takes the tree over, undoes it and fails it; then the old holder goes on. It
 * must not undo again: #605's check before the undo stops one held before it (no
 * `onCompensationStart` from it either), #640's check right before the undo action one held in
 * between. Its call rejects with `ExecutionLeaseLostError`.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { readyAll } from "./fixtures/child-end-freeze.js";
import { endOnceSeen, resetEndOnce } from "./fixtures/child-end-once.workflow.js";
import { UndoLocalWorkflowStart } from "./fixtures/child-failure-once.workflow.js";
import { resetMatrix, takeoversSeen } from "./fixtures/end-once-matrix.workflow.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import { resetUndo, UndoChildWorkflowStart, undoSeen } from "./fixtures/finished-undo.workflow.js";
import { JoinUndoWorkflowStart } from "./fixtures/join-undo.workflow.js";
import { openGate, resetYield, yieldSeen } from "./fixtures/remote-child-yield.workflow.js";
import {
  armUndoStartGate,
  UndoHold,
  undoStartGate,
  UndoObserverGateApplication,
} from "./fixtures/undo-observer-gate.application.js";

const test = testWith(UndoObserverGateApplication, { instances: 2 });

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetUndo();
  resetMatrix();
  resetLogged();
});

const rootFailures = () => endOnceSeen.errors.filter((each) => each.executionId === "execution-1");

const UNDOS = [
  { undo: "a root's own undo", start: UndoChildWorkflowStart },
  { undo: "a failed join's undo", start: JoinUndoWorkflowStart },
  { undo: "a child's undo", start: UndoLocalWorkflowStart },
] as const;

describe("#605 / #640: a holder held past its lease before its undo action undoes nothing", () => {
  for (const { undo, start } of UNDOS)
    for (const at of Object.values(UndoHold))
      test(`${undo}, held ${at}: the new holder's undo is the only one`, async ({
        apps,
        clock,
        leases,
      }) => {
        const [a] = apps;
        if (a === undefined) throw new Error("two instances");
        const byId = await readyAll(apps);
        const old = [...byId].find(([, each]) => each === a)?.[0];
        armUndoStartGate(at);
        openGate();
        const call = rejectionOf(execute(a, start, item("gate", "fail"), { threadId: "t" }));
        await until(() => undoStartGate.held.length === 1, `the old holder's undo held ${at}`);
        leases.stall(a);
        const isTakenOver = (): boolean =>
          takeoversSeen.some((each) => each.previous === old && each.holder !== old);
        for (let step = 0; step < 24 && rootFailures().length === 0; step += 1) {
          await clock.advance(seconds(10));
          await settle();
        }
        await until(() => rootFailures().length > 0, "the new holder undid and failed the tree");
        await settle();
        undoStartGate.release();
        leases.resume(a);
        const error = await call;
        await settle();

        expect(undoStartGate.held).toEqual([old]);
        expect(isTakenOver()).toBe(true);
        expect(error).toBeInstanceOf(ExecutionLeaseLostError);
        expect(undoSeen.cancelled).toHaveLength(1);
        expect(undoSeen.cancelled[0]).not.toContain(old ?? "unknown");
        expect(rootFailures()).toHaveLength(1);
        expect(rootFailures()[0]?.instanceId).not.toBe(old);
        // held before the undo: #605's check stops it before it says it starts
        const starts = undoStartGate.started.filter((each) => each === old);
        if (at === UndoHold.DoneMarkRead) expect(starts).toEqual([]);
      });
});

const AT_GATE = [
  { undo: "a child's undo", start: UndoLocalWorkflowStart },
  { undo: "a root's own undo", start: UndoChildWorkflowStart },
  { undo: "a failed join's undo", start: JoinUndoWorkflowStart },
] as const;

/**
 * #605 AC1 as first written: the old holder's step held at its gate while its lease is frozen. It
 * is stopped at its next checkpoint renewal, before its undo — never at the undo's fence, so these
 * cases pass without it; the cases above bite.
 */
describe("#605 AC1: a holder that lost the tree while its step ran undoes nothing", () => {
  for (const { undo, start } of AT_GATE)
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
