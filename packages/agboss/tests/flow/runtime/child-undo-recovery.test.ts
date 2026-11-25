import { beforeEach, describe, expect, vi } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { kill, resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  ChargedTripWorkflowStart,
  CommitTripWorkflowStart,
  DeclinedTripWorkflowStart,
  TripBookingDesk,
  TripDesk,
} from "../fixtures/child-undo.fixture.js";
import {
  childEndGate,
  ChildUndoRecoveryApplication,
  resetChildEndGate,
  resetUndoStartGate,
  undoStartGate,
} from "./fixtures/child-undo-recovery.application.js";
import { JoinDeclinedTripWorkflowStart } from "./fixtures/held-undo.workflow.js";

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
  resetUndoStartGate();
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
      "a parent whose failed step an .onError takes undoes each reservation once, before its side path (#1281)",
      DeclinedTripWorkflowStart,
      "declined",
      ["room-1", "seat-1"],
      "finished trip-not-reserved-workflow-finish",
    ],
    [
      "a parent whose failed join an .onError takes undoes each reservation once, before its side path (#1281 (10))",
      JoinDeclinedTripWorkflowStart,
      "declined",
      ["room-1", "seat-1"],
      "finished trip-not-reserved-workflow-finish",
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

/**
 * #1281 (10) — a takeover in the middle of a failed join's undo of what the child held: the room (the
 * newest) was released and marked done, the instance is killed before the seat's undo. The instance
 * that takes the tree over runs the join again: it reads the room's mark and closes it without
 * releasing it again, releases the seat, and the side path finishes — each reservation once.
 */
describe("#1281 (10): a crash between two undos of a failed join's held entries", () => {
  for (const [title, start] of [
    ["a failed branch's join", JoinDeclinedTripWorkflowStart],
    ["a plain step's failure", DeclinedTripWorkflowStart],
  ] as const) {
    pair(
      `${title}: the new holder undoes the rest, each reservation exactly once`,
      async ({ apps, clock, mockOf }) => {
        const desk = mockOf(TripBookingDesk);
        desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
        mockOf(TripDesk).charge.mockRejectedValue(new Error("the card is declined"));
        const [first] = await both(apps);
        undoStartGate.at = 2;
        const run = execute(first, start, GUEST, THREAD);
        run.catch(() => undefined);
        await vi.waitFor(() => {
          expect(undoStartGate.reached).toBe(true);
        });
        expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1"]);

        kill("instance-1");
        await clock.advance(seconds(10));
        undoStartGate.release();
        await expect(run).rejects.toThrow();
        await clock.advance(seconds(21));
        await vi.waitFor(() => {
          expect(childEndGate.rootEnds).toEqual(["finished trip-not-reserved-workflow-finish"]);
        });

        expect(desk.reserve.mock.calls).toHaveLength(2);
        expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
      },
    );
  }
});
