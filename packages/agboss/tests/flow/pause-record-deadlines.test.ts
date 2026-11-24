/**
 * #1366: how a pause's deadline fields combine its own deadline with its run's and its quorum's — the earliest
 * is its deadline (a tie goes to the run, then the quorum), `boundAt` is the earlier of the run's and the
 * quorum's whichever order they are given in, and a reminder is set only strictly between the ask and the deadline.
 */
import { describe, expect, it } from "vitest";
import type { FrameSpec } from "../../src/flow/context/frame.js";
import { PauseExpiryBound } from "../../src/infrastructure/pause-record.js";
import {
  boundedDeadlineOf,
  deadlineOf,
  reminderOf,
} from "../../src/flow/runtime/pause-record-made.js";
import { hours, minutes, workingHours, type WorkingDuration } from "../../src/units/index.js";

const T05 = "2026-01-01T00:05:00.000Z";
const T10 = "2026-01-01T00:10:00.000Z";
const T20 = "2026-01-01T00:20:00.000Z";
const ASKED = new Date("2026-01-01T00:00:00.000Z");

const frameOf = (run?: string, quorum?: string): FrameSpec =>
  ({
    execution: {
      ...(run === undefined ? {} : { deadline: { at: run, deadline: 1 } }),
      ...(quorum === undefined ? {} : { quorumDeadlineAt: quorum }),
    },
  }) as never;

describe("#1366: the deadline a pause is bound by", () => {
  it("is the earlier of the run's and the quorum's, in either order", () => {
    expect(boundedDeadlineOf(frameOf(T05, T10), T20)).toMatchObject({ boundAt: T05 });
    expect(boundedDeadlineOf(frameOf(T10, T05), T20)).toMatchObject({ boundAt: T05 });
  });

  it("is the one given when only one of them is", () => {
    expect(boundedDeadlineOf(frameOf(T10), T20)).toMatchObject({ boundAt: T10 });
    expect(boundedDeadlineOf(frameOf(undefined, T10), T20)).toMatchObject({ boundAt: T10 });
  });

  it("is none without either, and the pause's own deadline is then all there is", () => {
    expect(boundedDeadlineOf(frameOf(), T10)).toEqual({
      expiresAt: T10,
      expiryBound: PauseExpiryBound.Pause,
    });
    expect(boundedDeadlineOf(frameOf(), undefined)).toEqual({});
  });

  it("does not move for a pause's own deadline: it is the run's and the quorum's alone", () => {
    expect(boundedDeadlineOf(frameOf(T10, T20), T05)).toEqual({
      expiresAt: T05,
      expiryBound: PauseExpiryBound.Pause,
      boundAt: T10,
    });
  });
});

describe("#1366: the deadline a pause expires at", () => {
  it("is the earliest of its own, the run's and the quorum's, and says whose it is", () => {
    expect(boundedDeadlineOf(frameOf(T10, T20), T05)).toMatchObject({ expiresAt: T05 });
    expect(boundedDeadlineOf(frameOf(T05, T20), T10)).toMatchObject({
      expiresAt: T05,
      expiryBound: PauseExpiryBound.RunDeadline,
    });
    expect(boundedDeadlineOf(frameOf(T20, T05), T10)).toMatchObject({
      expiresAt: T05,
      expiryBound: PauseExpiryBound.Quorum,
    });
  });

  it("goes on a tie to the run, then to the quorum over the pause's own", () => {
    expect(boundedDeadlineOf(frameOf(T10, T10), T10)).toMatchObject({
      expiryBound: PauseExpiryBound.RunDeadline,
    });
    expect(boundedDeadlineOf(frameOf(undefined, T10), T10)).toMatchObject({
      expiryBound: PauseExpiryBound.Quorum,
    });
  });

  it("deadlineOf adds the span to the ask: the pause's own deadline, none without a span", () => {
    expect(deadlineOf(frameOf(), minutes(10), ASKED)).toMatchObject({ expiresAt: T10 });
    expect(deadlineOf(frameOf(T05), minutes(10), ASKED)).toMatchObject({
      expiresAt: T05,
      boundAt: T05,
    });
    expect(deadlineOf(frameOf(), undefined, ASKED)).toEqual({});
  });
});

describe("#1366: a working-time reminder", () => {
  const add = (from: Date, amount: WorkingDuration): Promise<Date> =>
    Promise.resolve(new Date(from.getTime() + amount.amount));

  it("is the calendar's instant for the deadline's span less the lead, when it is before the deadline", async () => {
    const at = await reminderOf(
      ASKED,
      { expiresAt: new Date(ASKED.getTime() + hours(2)).toISOString(), expiresIn: workingHours(2) },
      workingHours(1),
      add,
    );

    expect(at).toBe(new Date(ASKED.getTime() + hours(1)).toISOString());
  });

  it("is none when the lead is the whole span or more, or the calendar's instant is not before the deadline", async () => {
    const whole = {
      expiresAt: new Date(ASKED.getTime() + hours(2)).toISOString(),
      expiresIn: workingHours(2),
    };

    expect(await reminderOf(ASKED, whole, workingHours(2), add)).toBeUndefined();
    expect(await reminderOf(ASKED, whole, workingHours(3), add)).toBeUndefined();
    // the deadline was clamped to the reminder's own instant: strictly before it is required
    const clamped = {
      expiresAt: new Date(ASKED.getTime() + hours(1)).toISOString(),
      expiresIn: workingHours(2),
    };
    expect(await reminderOf(ASKED, clamped, workingHours(1), add)).toBeUndefined();
  });

  it("asks the calendar nothing when the lead is not positive", async () => {
    const asked: number[] = [];
    const counting = (from: Date, amount: WorkingDuration): Promise<Date> => {
      asked.push(amount.amount);
      return add(from, amount);
    };
    const whole = {
      expiresAt: new Date(ASKED.getTime() + hours(2)).toISOString(),
      expiresIn: workingHours(2),
    };

    await reminderOf(ASKED, whole, workingHours(2), counting);

    expect(asked).toEqual([]);
  });
});
