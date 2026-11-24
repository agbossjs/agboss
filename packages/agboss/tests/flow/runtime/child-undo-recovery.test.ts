import { beforeEach, describe, expect, vi } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { kill, resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  ChargedTripWorkflowStart,
  CommitTripWorkflowStart,
  TripBookingDesk,
  TripDesk,
} from "../fixtures/child-undo.fixture.js";
import {
  childEndGate,
  ChildUndoRecoveryApplication,
  resetChildEndGate,
} from "./fixtures/child-undo-recovery.application.js";

/**
 * #1281b — a crash between a child's finish and its parent taking what the finish moved up: the
 * child's finish is durable (its moved entries in its own checkpoint), the parent's step never
 * wrote. The instance that takes the tree over runs the parent's step again, finds the child
 * finished and takes its entries once by their compensation keys: a parent that then fails undoes
 * each reservation exactly once, a parent that finishes commits them — none lost, none doubled. The
 * frozen instance, let go after its lease is gone, takes nothing (its fence).
 */

const pair = testWith(ChildUndoRecoveryApplication, { instances: 2 });
const GUEST = { guest: "ada" };
const THREAD = { threadId: "t-1" };

beforeEach(() => {
  resetRecovery();
  resetChildEndGate();
});

async function both(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

describe("#1281b: a crash between a child's finish and its parent's step", () => {
  for (const [title, start, charge, released, end] of [
    [
      "a parent that fails afterwards undoes each reservation once",
      ChargedTripWorkflowStart,
      "declined",
      ["room-1", "seat-1"],
      "failed",
    ],
    [
      "a parent that finishes commits them: nothing is undone",
      CommitTripWorkflowStart,
      "paid",
      [],
      "finished trip-booked-workflow-finish",
    ],
  ] as const) {
    pair(title, async ({ apps, clock, mockOf }) => {
      const desk = mockOf(TripBookingDesk);
      desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
      if (charge === "declined")
        mockOf(TripDesk).charge.mockRejectedValue(new Error("the card is declined"));
      const [first] = await both(apps);
      childEndGate.isArmed = true;
      const run = execute(first, start, GUEST, THREAD);
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(childEndGate.reached).toBe(true);
      });

      kill("instance-1");
      await clock.advance(seconds(10));
      childEndGate.release();
      await expect(run).rejects.toThrow();
      await clock.advance(seconds(21));
      await vi.waitFor(() => {
        expect(childEndGate.rootEnds).toEqual([end]);
      });

      expect(desk.reserve.mock.calls).toHaveLength(2);
      expect(desk.release.mock.calls.map(([id]) => id)).toEqual(released);
    });
  }
});
