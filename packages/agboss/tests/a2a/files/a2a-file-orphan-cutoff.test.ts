/**
 * #1366: how old A2A files must be for the recovery sweep to look at them — older than its cutoff and older than a
 * minute (a file uploaded as its task is being created has no task yet): the earlier of the two.
 */
import { describe, expect, it } from "vitest";
import { fileExpiryOf } from "../../../src/infrastructure/file.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, minutes, seconds } from "../../../src/units/index.js";

/** The sweep's look at owners: what it asked for. */
function sweepWith(clock: VirtualClock) {
  const asked: { before: number; pageSize: number }[] = [];
  const removed: string[] = [];
  const sources = {
    clock,
    pageSize: 2,
    retention: undefined,
    files: {
      findOwnersByCreatedAtBefore: (before: Date, pageSize: number) => {
        asked.push({ before: before.getTime(), pageSize });
        return Promise.resolve([]);
      },
      deleteByOwner: (owner: { ownerId: string }) => {
        removed.push(owner.ownerId);
        return Promise.resolve();
      },
    },
    tasks: { findById: () => Promise.resolve(undefined) },
  };
  return { expiry: fileExpiryOf(sources as never), asked, removed };
}

describe("#1366: which A2A files the sweep looks at", () => {
  it("a cutoff in the last minute is held back to a minute ago: a file with no task yet is not an orphan", async () => {
    const clock = new VirtualClock();
    const { expiry, asked } = sweepWith(clock);

    await expiry.remove?.(new Date(clock.now().getTime() + hours(1)));

    expect(asked).toEqual([{ before: clock.now().getTime() - seconds(60), pageSize: 2 }]);
  });

  it("an older cutoff is the cutoff", async () => {
    const clock = new VirtualClock();
    const { expiry, asked } = sweepWith(clock);
    const cutoff = new Date(clock.now().getTime() - minutes(30));

    await expiry.remove?.(cutoff);

    expect(asked.map((look) => look.before)).toEqual([cutoff.getTime()]);
  });
});
