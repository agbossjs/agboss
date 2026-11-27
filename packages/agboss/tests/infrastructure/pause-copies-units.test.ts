/**
 * #1307 (G3, pauses shard) — the copy boundaries of the in-memory pause store: every record and
 * notice it hands out, and every Date it takes in, is a fresh instance, so a `setTime` on one never
 * moves what the store holds (a compare-and-set reads it) — whichever door the record goes out by.
 */
import { describe, expect, it } from "vitest";
import { copiedNotice, copiedPause } from "../../src/infrastructure/pause-copies.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { PauseNoticeKind, type PauseNotice } from "../../src/infrastructure/pause-notices.js";
import { PauseStatus, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { seenOf } from "../../src/infrastructure/pause-seen.js";
import {
  APPROVED_BY_MANAGER,
  NINE,
  RECIPIENTS,
} from "../../src/testing/contracts/paused-execution-data.js";
import {
  asked,
  deadline,
  preciseOf,
  reminder,
} from "../../src/testing/contracts/paused-execution-instants-data.js";

/** Every `Date` of a pause, with the name of its place. */
const datesOf = (pause: PauseRecord): Record<string, Date> => {
  const named: Record<string, Date | undefined> = {
    askedAt: pause.askedAt,
    firstAskedAt: pause.firstAskedAt,
    maxExpiresAt: pause.maxExpiresAt,
    resolvedAt: pause.resolvedAt,
    expiresAt: pause.expiresAt,
    remindAt: pause.remindAt,
    boundAt: pause.boundAt,
    "closedFirst.resolvedAt": pause.closedFirst?.resolvedAt,
  };
  pause.trail.forEach((entry, index) => {
    named[`trail[${String(index)}].at`] = entry.at;
    named[`trail[${String(index)}].expiresAt`] = entry.expiresAt;
  });
  return Object.fromEntries(
    Object.entries(named).filter((entry): entry is [string, Date] => entry[1] !== undefined),
  );
};

const FULL: PauseRecord = {
  ...preciseOf("pause-a"),
  resolvedAt: new Date("2026-01-05T09:30:00.321Z"),
  closedFirst: { resolution: "replied", resolvedAt: new Date("2026-01-05T09:20:00.654Z") },
} as PauseRecord;

describe("copiedPause (#1307)", () => {
  it("is a pause of the same instants in no instance of the original's, every time of it", () => {
    const copy = copiedPause(FULL);
    const before = datesOf(FULL);
    const after = datesOf(copy);

    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.keys(after)).toContain("closedFirst.resolvedAt");
    for (const [place, date] of Object.entries(after)) {
      expect(date, place).not.toBe(before[place]);
      expect(date.getTime(), place).toBe(before[place]?.getTime());
    }
  });

  it("a pause with no optional time has none after: nothing is made of an absent time", () => {
    const {
      maxExpiresAt: _maxExpiresAt,
      resolvedAt: _resolvedAt,
      expiresAt: _expiresAt,
      remindAt: _remindAt,
      boundAt: _boundAt,
      ...bare
    } = { ...preciseOf("pause-a"), resolvedAt: undefined };

    const copy = copiedPause(bare);

    for (const key of ["maxExpiresAt", "resolvedAt", "expiresAt", "remindAt", "boundAt"])
      expect(copy, key).not.toHaveProperty(key);
  });
});

describe("copiedNotice (#1307)", () => {
  it("is a notice of the same instants in no instance of the original's", () => {
    const notice: PauseNotice = {
      seq: 1,
      kind: PauseNoticeKind.Closed,
      writtenAt: new Date(1),
      closedAt: new Date(2),
      expiresAt: new Date(3),
      previousExpiresAt: new Date(4),
    };

    const copy = copiedNotice(notice);

    for (const key of ["writtenAt", "closedAt", "expiresAt", "previousExpiresAt"] as const) {
      expect(copy[key], key).not.toBe(notice[key]);
      expect(copy[key]?.getTime(), key).toBe(notice[key]?.getTime());
    }
    expect(
      copiedNotice({ seq: 1, kind: PauseNoticeKind.Closed, writtenAt: new Date(1) }),
    ).not.toHaveProperty("closedAt");
  });
});

/** The value, which a test says is there. */
const present = <T>(value: T | undefined): T =>
  value ?? expect.fail("expected a value, got undefined");

/** Sets every Date of the pause to the epoch. */
const moved = (pause: PauseRecord | undefined): void => {
  for (const date of Object.values(datesOf(present(pause)))) date.setTime(0);
};

describe("InMemoryPausedExecutionRepository's doors (#1307)", () => {
  const made = async () => {
    const store = new InMemoryPausedExecutionRepository();
    await store.findOrCreateByStepKey(preciseOf("pause-a"));
    return store;
  };
  const expectUntouched = async (store: InMemoryPausedExecutionRepository, what: string) => {
    const pause = await store.findByTenantIdAndPauseId("default", "pause-a");
    expect(pause?.expiresAt?.getTime(), what).toBe(deadline().getTime());
    expect(pause?.askedAt.getTime(), what).toBe(asked().getTime());
    expect(pause?.remindAt?.getTime(), what).toBe(reminder().getTime());
    expect(pause?.trail[0]?.at.getTime(), what).toBe(asked().getTime());
  };

  it("the pause findOrCreateByStepKey found, and the one it made, are the caller's own", async () => {
    const store = await made();

    moved(await store.findOrCreateByStepKey(preciseOf("pause-a")));
    await expectUntouched(store, "found");

    const second = new InMemoryPausedExecutionRepository();
    const given = preciseOf("pause-a");
    moved(await second.findOrCreateByStepKey(given));
    await expectUntouched(second, "made");
  });

  it("the pause found by its step key, the tree's listing and every page are the caller's own", async () => {
    const store = await made();
    const root = preciseOf("pause-a").rootExecutionId;

    moved(
      await store.findByTenantIdAndRootExecutionIdAndStepKey(
        "default",
        root,
        "run-1:clerk-agent:1:call-1",
      ),
    );
    for (const pause of await store.findAllByTenantIdAndRootExecutionId("default", root))
      moved(pause);
    for (const pause of (await store.findOpenAfter(undefined, 10)).pauses) moved(pause);
    for (const pause of (
      await store.findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 10)
    ).pauses)
      moved(pause);
    for (const pause of (await store.findPageOfAllTenants({ statuses: [PauseStatus.Pending] }, 10))
      .pauses)
      moved(pause);
    for (const pause of await store.findPendingByRemindAtBefore(new Date(Date.UTC(2027, 0, 1)), 10))
      moved(pause);

    await expectUntouched(store, "after the reads");
  });

  it("the replacements the unsent-reassigned scan lists are the caller's own", async () => {
    const store = await made();
    const read = await store.findByTenantIdAndPauseId("default", "pause-a");
    await store.reassignByTenantIdAndPauseId(
      "default",
      "pause-a",
      { pauseId: "pause-r", assignees: ["x"], seen: seenOf(present(read)) },
      new Date(NINE),
      RECIPIENTS,
    );
    const cutoff = new Date(NINE.getTime() + 1);

    for (const pause of await store.findPendingUnsentReassignedBefore(cutoff, 10)) {
      expect(pause.pauseId).toBe("pause-r");
      moved(pause);
    }

    const replacement = await store.findByTenantIdAndPauseId("default", "pause-r");
    expect(replacement?.askedAt.getTime()).toBe(NINE.getTime());
    expect(replacement?.expiresAt?.getTime()).toBe(deadline().getTime());
    expect(await store.findPendingUnsentReassignedBefore(cutoff, 10)).toHaveLength(1);
  });

  it("the record each transition returns is the caller's own", async () => {
    const store = await made();

    moved(
      await store.resolveByTenantIdAndPauseId(
        "default",
        "pause-a",
        APPROVED_BY_MANAGER,
        new Date(NINE),
        RECIPIENTS,
      ),
    );

    const resolved = await store.findByTenantIdAndPauseId("default", "pause-a");
    expect(resolved?.status).toBe(PauseStatus.Resolved);
    expect(resolved?.resolvedAt?.getTime()).toBe(NINE.getTime());
    expect(resolved?.askedAt.getTime()).toBe(asked().getTime());
  });

  it("a timeout change planned over a deadline a listener moved still applies: the stored deadline is never the one a caller holds", async () => {
    const store = await made();
    const read = await store.findByTenantIdAndPauseId("default", "pause-a");
    const changed = await store.changeTimeoutByTenantIdAndPauseId(
      "default",
      "pause-a",
      {
        expiresAt: new Date(deadline().getTime() + 1000),
        previousExpiresAt: new Date(deadline().getTime()),
        seen: seenOf(present(read)),
      },
      new Date(NINE),
      RECIPIENTS,
    );
    // what an app listener does with the record it received
    changed?.expiresAt?.setTime(0);

    const reread = await store.findByTenantIdAndPauseId("default", "pause-a");
    const again = await store.changeTimeoutByTenantIdAndPauseId(
      "default",
      "pause-a",
      {
        expiresAt: new Date(deadline().getTime() + 2000),
        previousExpiresAt: new Date(deadline().getTime() + 1000),
        seen: seenOf(present(reread)),
      },
      new Date(NINE),
      RECIPIENTS,
    );

    expect(again?.expiresAt?.getTime()).toBe(deadline().getTime() + 2000);
  });
});
