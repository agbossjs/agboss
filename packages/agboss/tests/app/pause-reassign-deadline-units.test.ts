/**
 * #1307d, #1356 (shard `pauses`) — the deadline a reassignment sets (`pause-reassign-deadline.ts`), on its own: none for a
 * pause that keeps its target and its deadline, the call's timeout or else the destination's own (its hook, then
 * its `timeout`), the earliest of that, the chain's total wait and the run's or quorum's bound — which bound it
 * is —, a deadline already due refused naming the limit, and the reminder only for a deadline of the target's own span.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { deadlineAfter } from "../../src/app/pause-reassign-deadline.js";
import type { PauseTarget } from "../../src/flow/runtime/pause-channel.js";
import {
  pauseKeyOf,
  PauseExpiryBound,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { hours, seconds, workingHours, type WorkingDuration } from "../../src/units/index.js";

const calendar = vi.hoisted(() => ({ add: vi.fn(), remind: vi.fn() }));
vi.mock("../../src/app/pause-calendar.js", () => ({
  calendarOfTarget: () => ({ add: calendar.add, remind: calendar.remind }),
}));

const NOW = new Date("2026-01-05T10:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const PAUSE: PauseRecord = { ...pauseOf("p-1"), expiresAt: at(3_600_000) };
const KEY = pauseKeyOf(PAUSE.tenantId, PAUSE.pauseId);
const parts = { deps: {}, clock: { now: () => NOW } } as never;

const target = (changes: Partial<PauseTarget> = {}): PauseTarget =>
  ({ name: "alpha-tool-approval", channels: new Map(), ...changes }) as PauseTarget;

const after = (
  ask: { timeout?: ReturnType<typeof seconds>; isExpiry?: boolean } = {},
  options: {
    pause?: PauseRecord;
    from?: PauseTarget;
    to?: PauseTarget;
    cap?: Date;
    assignees?: readonly string[];
  } = {},
) => {
  const from = options.from ?? target();
  return deadlineAfter(
    parts,
    options.pause ?? PAUSE,
    { from, to: options.to ?? from },
    options.assignees,
    { isExpiry: false, ...ask },
    options.cap,
  );
};

const refusal = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("not refused");
};

describe("#1307d: the deadline a reassignment sets", () => {
  it("is none for a pause that stays under its target with no timeout asked — unless it is an expiry's, which always sets one", async () => {
    const own = target({ timeout: hours(2) });

    expect(await after({}, { from: own })).toBeUndefined();
    expect(await after({ isExpiry: true }, { from: own })).toEqual({
      expiresAt: at(7_200_000),
      expiryBound: PauseExpiryBound.Pause,
    });
  });

  it("is the call's timeout from now; else the destination's hook; else its own timeout — the hook asked with the pause and its new assignees", async () => {
    const resolveTimeout = vi.fn((_context: unknown) => Promise.resolve(seconds(90)));
    const to = target({ name: "beta-tool-approval", timeout: hours(2) });
    const hooked = target({ name: "beta-tool-approval", timeout: hours(2), resolveTimeout });

    const asked = await after({ timeout: seconds(60) }, { to: hooked });
    const byHook = await after({}, { to: hooked, assignees: ["bob"] });
    const own = await after({}, { to });

    expect(asked).toMatchObject({ expiresAt: at(60_000) });
    expect(byHook).toMatchObject({ expiresAt: at(90_000) });
    expect(own).toMatchObject({ expiresAt: at(7_200_000) });
    expect(resolveTimeout).toHaveBeenCalledExactlyOnceWith({
      input: PAUSE.input,
      assignees: ["bob"],
      toolCall: PAUSE.toolCall,
      trail: PAUSE.trail,
    });
  });

  it("a destination with no wait of its own sets no deadline: an empty change that keeps the pause waiting without one", async () => {
    const to = target({ name: "beta-tool-approval" });

    expect(await after({}, { to })).toStrictEqual({});
  });

  it("is the earlier of the wait and the chain's total: the cap, only when it is strictly earlier", async () => {
    const to = target({ name: "beta-tool-approval", timeout: hours(2) });

    const capped = await after({}, { to, cap: at(1_000_000) });
    const later = await after({}, { to, cap: at(9_000_000) });
    const tie = await after({}, { to, cap: at(7_200_000) });
    const unbounded = await after({}, { to: target({ name: "b" }), cap: at(1_000_000) });

    expect(capped).toEqual({ expiresAt: at(1_000_000), expiryBound: PauseExpiryBound.Pause });
    expect(later).toMatchObject({ expiresAt: at(7_200_000) });
    expect(tie).toMatchObject({ expiresAt: at(7_200_000) });
    expect(unbounded).toEqual({ expiresAt: at(1_000_000), expiryBound: PauseExpiryBound.Pause });
  });

  it("is the run's bound when that is strictly earlier — the run's, or the quorum's for a quorum's pause — and the pause's own on a tie or when later", async () => {
    const to = target({ name: "beta-tool-approval", timeout: hours(2) });
    const bounded = (boundAt: Date, expiryBound?: PauseExpiryBound): PauseRecord => ({
      ...PAUSE,
      boundAt,
      ...(expiryBound === undefined ? {} : { expiryBound }),
    });

    const run = await after({}, { to, pause: bounded(at(1_000_000)) });
    const quorum = await after({}, { to, pause: bounded(at(1_000_000), PauseExpiryBound.Quorum) });
    const tie = await after({}, { to, pause: bounded(at(7_200_000)) });
    const later = await after({}, { to, pause: bounded(at(9_000_000)) });
    const unbounded = await after({}, { to: target({ name: "b" }), pause: bounded(at(1_000_000)) });

    expect(run).toEqual({ expiresAt: at(1_000_000), expiryBound: PauseExpiryBound.RunDeadline });
    expect(quorum).toEqual({ expiresAt: at(1_000_000), expiryBound: PauseExpiryBound.Quorum });
    expect(tie).toMatchObject({ expiresAt: at(7_200_000), expiryBound: PauseExpiryBound.Pause });
    expect(later).toMatchObject({ expiresAt: at(7_200_000), expiryBound: PauseExpiryBound.Pause });
    expect(unbounded).toEqual({
      expiresAt: at(1_000_000),
      expiryBound: PauseExpiryBound.RunDeadline,
    });
  });

  it("already due at the clock's now is refused, naming the limit — also at the very instant", async () => {
    const to = target({ name: "beta-tool-approval", timeout: hours(2) });

    for (const cap of [NOW, at(-1000)]) {
      const error = await refusal(after({}, { to, cap }));
      expect(error).toBeInstanceOf(PauseError.EscalationLimitExceeded);
      expect(error.message).toBe(`pause ${KEY}: its maxTotalTimeout limit is reached`);
    }
  });

  it("carries the reminder before the deadline when the destination reminds, and none otherwise", async () => {
    const reminding = target({
      name: "beta-tool-approval",
      timeout: hours(2),
      remindBefore: hours(1),
    });
    const plain = target({ name: "beta-tool-approval", timeout: hours(2) });

    const withReminder = await after({}, { to: reminding });
    const without = await after({}, { to: plain });
    const capped = await after({}, { to: reminding, cap: at(1_800_000) });

    expect(withReminder).toEqual({
      expiresAt: at(7_200_000),
      expiryBound: PauseExpiryBound.Pause,
      remindAt: at(3_600_000),
    });
    expect(without).not.toHaveProperty("remindAt");
    expect(capped).toMatchObject({ expiresAt: at(1_800_000) });
  });
});

describe("#944: the calendar of the destination", () => {
  beforeEach(() => {
    calendar.add.mockReset();
    calendar.remind.mockReset();
    calendar.add.mockImplementation((from: Date, amount: WorkingDuration) =>
      Promise.resolve(new Date(from.getTime() + amount.amount)),
    );
  });

  it("counts a working-time wait and its reminder: the add and the remind of the destination's calendar are the ones asked", async () => {
    calendar.remind.mockResolvedValue(at(5_000));
    const to = target({
      name: "beta-tool-approval",
      timeout: workingHours(2),
      remindBefore: workingHours(1),
    });

    const set = await after({}, { to });

    expect(calendar.add).toHaveBeenCalled();
    expect(calendar.remind).toHaveBeenCalledExactlyOnceWith({
      at: NOW,
      expiresAt: at(7_200_000),
      expiresIn: workingHours(2),
      remindBefore: workingHours(1),
    });
    expect(set).toEqual({
      expiresAt: at(7_200_000),
      expiryBound: PauseExpiryBound.Pause,
      remindAt: at(5_000),
    });
  });

  it("a deadline that is the chain's cap, not the target's own span, carries no reminder though the target reminds", async () => {
    const to = target({ name: "beta-tool-approval", remindBefore: hours(1) });

    const set = await after({}, { to, cap: at(7_200_000) });

    expect(set).toStrictEqual({ expiresAt: at(7_200_000), expiryBound: PauseExpiryBound.Pause });
  });
});
