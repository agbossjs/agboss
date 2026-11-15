/**
 * #944 AC1, AC4: a question asked with `expiresIn: workingHours(2)` in Tel Aviv's office (Sunday to
 * Thursday, 09:00–18:00, lunch 13:00–14:00; IST is UTC+2 in January) is due by the calendar, its
 * reminder `workingHours(1)` before counts working time the same way, and an extension by
 * `workingHours(8)` is `calendar.add(now, 8 h)`. The run's deadline stays wall-clock: the smaller
 * wins, a tie goes to the run (#941 D8). The virtual clock starts Monday 2026-01-05 09:00Z and is
 * moved to explicit instants; no machine zone is read.
 */
import { beforeEach, describe, expect } from "vitest";
import { DtoValidationError } from "../../src/errors.js";
import { PauseStatus } from "../../src/index.js";
import { PauseExpiryBound } from "../../src/infrastructure/pause-record.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { hours, workingHours, workingMinutes } from "../../src/units/index.js";
import { WorkingWeek } from "../../src/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { workingApp, workingToolApp } from "../flow/fixtures/working-time-app.js";
import { TEL_AVIV, WEEKDAYS } from "../calendar/helpers.js";
import { milliseconds } from "../calendar/units.js";

const ORDER = { orderId: "o-1" };
const manager = { answeredBy: "manager-17" };

/** The clock moved to an explicit instant (it only moves forward). */
async function moveTo(clock: VirtualClock, instant: string): Promise<void> {
  await clock.advance(milliseconds(Date.parse(instant) - clock.now().getTime()));
}

const pauseOf = async (app: TestApp, pauseId: string) => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId("default", pauseId);
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

const desk = workingApp("wt-desk", {
  role: { expiresIn: workingHours(2), remindBefore: workingHours(1) },
  calendar: WorkingWeek.of(TEL_AVIV),
});
const test = testWith(desk.application, { instances: 2 });
/** The id the channel was sent (a channel pause's id is the channel's to know). */
const sentId = (): string => desk.told.sent.at(-1)?.pauseId ?? "";

beforeEach(() => {
  desk.told.sent.length = 0;
  desk.told.expiring.length = 0;
});
const flow = desk;

describe("#944 AC1: the deadline in working time", () => {
  test("AC1: asked Thursday 17:30 Tel Aviv, 2 working hours → Sunday 10:30", async ({
    app,
    clock,
  }) => {
    await moveTo(clock, "2026-01-08T15:30:00.000Z");

    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });

    expect(paused.pending[0]?.expiresAt).toBe("2026-01-11T08:30:00.000Z");
  });

  test("AC1: asked Sunday 12:30, across lunch → 15:30", async ({ app, clock }) => {
    await moveTo(clock, "2026-01-11T10:30:00.000Z");

    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });

    expect(paused.pending[0]?.expiresAt).toBe("2026-01-11T13:30:00.000Z");
  });

  test("AC1: the deadline is the stored absolute instant: every instance reads it, the pause expires there", async ({
    apps,
    clock,
  }) => {
    for (const each of apps) await each.ready();
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances");
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(first, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();

    expect((await pauseOf(second, pauseId)).expiresAt).toBe("2026-01-11T08:30:00.000Z");
    expect((await pauseOf(second, pauseId)).expiryBound).toBe(PauseExpiryBound.Pause);
  });

  test("a deadline spanning the week end is a pause for days, not hours: open on Sunday 07:00Z, expired after 08:30Z", async ({
    app,
    clock,
  }) => {
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();

    await moveTo(clock, "2026-01-11T08:29:00.000Z");
    expect((await pauseOf(app, pauseId)).status).toBe(PauseStatus.Pending);
    await moveTo(clock, "2026-01-11T08:31:00.000Z");
    await until(async () => (await pauseOf(app, pauseId)).status !== PauseStatus.Pending);
    expect((await pauseOf(app, pauseId)).status).not.toBe(PauseStatus.Pending);
  });
});

describe("#944 AC4: the reminder and an extension count working time", () => {
  test("AC4: remindAt = calendar.add(askedAt, 2 h − 1 h) and the channel hears it once, expiring at the deadline", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();

    // Thursday 17:30 + 1 working hour: 30 min that day, 30 min of Sunday → 09:30 IST = 07:30Z
    expect((await pauseOf(app, pauseId)).remindAt).toBe("2026-01-11T07:30:00.000Z");
    await moveTo(clock, "2026-01-11T07:29:00.000Z");
    expect(desk.told.expiring).toEqual([]);
    await moveTo(clock, "2026-01-11T07:31:00.000Z");
    await until(() => desk.told.expiring.length === 1);

    expect(desk.told.expiring[0]?.expiresAt).toBe("2026-01-11T08:30:00.000Z");
  });

  test("AC4: extendPause by workingHours(8) is calendar.add(now, 8 h); its reminder 7 working hours from now", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();

    const extension = await app.extendPause({ pauseId, expiresIn: workingHours(8) }, manager);

    // 30 min Thursday + 7.5 h Sunday (09:00–13:00, 14:00–17:30) → Sunday 17:30 IST = 15:30Z
    expect(extension.expiresAt).toBe("2026-01-11T15:30:00.000Z");
    expect(extension.previousExpiresAt).toBe("2026-01-11T08:30:00.000Z");
    const pause = await pauseOf(app, pauseId);
    expect(pause.expiresAt).toBe("2026-01-11T15:30:00.000Z");
    // 8 h − 1 h = 7 working hours from now → Sunday 16:30 IST = 14:30Z
    expect(pause.remindAt).toBe("2026-01-11T14:30:00.000Z");
  });

  test("AC4: another instance extends: its calendar gives the same deadline, every instance reads it", async ({
    apps,
    clock,
  }) => {
    for (const each of apps) await each.ready();
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances");
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    await execute(first, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();

    const extension = await second.extendPause({ pauseId, expiresIn: workingHours(8) }, manager);

    expect(extension.expiresAt).toBe("2026-01-11T15:30:00.000Z");
    expect((await pauseOf(first, pauseId)).expiresAt).toBe("2026-01-11T15:30:00.000Z");
    expect((await pauseOf(first, pauseId)).remindAt).toBe("2026-01-11T14:30:00.000Z");
  });

  test("AC4: extendPause with a plain duration on a role whose reminder is working time → DtoValidationError, the pause unchanged", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();
    const before = await pauseOf(app, pauseId);

    const refused: unknown = await app
      .extendPause({ pauseId, expiresIn: hours(100) }, manager)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(DtoValidationError);
    expect(refused).toMatchObject({
      dto: "ExtendPauseRequest",
      issues: [
        {
          path: ".expiresIn",
          reason: "this role reminds in working time: extend it with workingHours / workingMinutes",
        },
      ],
    });
    expect(await pauseOf(app, pauseId)).toEqual(before);
  });

  test("an extension by working time that is not later than the deadline is refused like a plain one", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();

    // 1 working hour from Thursday 17:30 is Sunday 09:30: before the current Sunday 10:30
    const refused: unknown = await app
      .extendPause({ pauseId, expiresIn: workingHours(1) }, manager)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(DtoValidationError);
    expect((await pauseOf(app, pauseId)).expiresAt).toBe("2026-01-11T08:30:00.000Z");
  });

  test("an extension by working minutes is checked as a duration: at least seconds(1)", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1" });
    const pauseId = sentId();

    for (const expiresIn of [
      workingMinutes(0.01),
      5,
      "8h",
      undefined,
      { working: 1 },
      hours(1e9),
      workingHours(1e9),
    ]) {
      const refused: unknown = await app
        .extendPause({ pauseId, expiresIn } as never, manager)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(DtoValidationError);
    }
  });
});

describe("#944: the run's deadline stays wall-clock (#941 D8)", () => {
  test("a run deadline earlier than the working deadline wins, bound RunDeadline", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");

    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1", deadline: hours(10) });
    const pause = await pauseOf(app, sentId());

    expect(pause).toMatchObject({
      expiresAt: "2026-01-09T01:30:00.000Z",
      expiryBound: PauseExpiryBound.RunDeadline,
      boundAt: "2026-01-09T01:30:00.000Z",
    });
    // the reminder (Sunday 07:30Z) is after the clamped deadline: none
    expect(pause.remindAt).toBeUndefined();
  });

  test("a run deadline exactly at the working deadline: the tie goes to the run", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");

    // Thursday 15:30Z → Sunday 08:30Z is 65 hours
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1", deadline: hours(65) });
    const pause = await pauseOf(app, sentId());

    expect(pause).toMatchObject({
      expiresAt: "2026-01-11T08:30:00.000Z",
      expiryBound: PauseExpiryBound.RunDeadline,
    });
    expect(pause.remindAt).toBe("2026-01-11T07:30:00.000Z");
  });

  test("a run deadline later than the working deadline: the pause's own deadline, the run's as boundAt", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");

    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1", deadline: hours(100) });
    const pause = await pauseOf(app, sentId());

    expect(pause).toMatchObject({
      expiresAt: "2026-01-11T08:30:00.000Z",
      expiryBound: PauseExpiryBound.Pause,
      boundAt: "2026-01-12T19:30:00.000Z",
    });
  });

  test("an extension past the run's deadline is refused, to exactly it allowed — by working time too", async ({
    app,
    clock,
  }) => {
    await app.ready();
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    // the run's deadline: Sunday 15:30Z (17:30 IST) = 8 working hours from now
    const paused = await execute(app, flow.start, ORDER, { threadId: "t-1", deadline: hours(72) });
    const pauseId = sentId();

    const past: unknown = await app
      .extendPause({ pauseId, expiresIn: workingHours(9) }, manager)
      .catch((error: unknown) => error);
    expect(past).toBeInstanceOf(DtoValidationError);
    expect(String((past as DtoValidationError).issues[0]?.reason)).toContain("bound");

    const exact = await app.extendPause({ pauseId, expiresIn: workingHours(8) }, manager);
    expect(exact.expiresAt).toBe("2026-01-11T15:30:00.000Z");
  });
});

const newYork = workingApp("wt-newyork", {
  role: {
    expiresIn: workingHours(2),
    workingCalendar: WorkingWeek.of({
      timeZone: "America/New_York",
      days: WEEKDAYS,
      hours: [{ from: "09:00", to: "17:00" }],
    }),
  },
  calendar: WorkingWeek.of(TEL_AVIV),
});
const overrideTest = testWith(newYork.application);

describe("#944: a role's own calendar over the application's", () => {
  overrideTest(
    "a role override in another time zone counts its own hours",
    async ({ app, clock }) => {
      await app.ready();
      // Friday 2026-01-09 16:00 EST = 21:00Z: 1 h that day, Monday 09:00 + 1 h → 10:00 EST = 15:00Z
      await moveTo(clock, "2026-01-09T21:00:00.000Z");

      const paused = await execute(app, newYork.start, ORDER, { threadId: "t-1" });

      expect(paused.pending[0]?.expiresAt).toBe("2026-01-12T15:00:00.000Z");
    },
  );
});

const plainRole = workingApp("wt-plain", {
  role: { expiresIn: hours(24), remindBefore: hours(2) },
});
const plainTest = testWith(plainRole.application);

describe("#944: extendPause with working time on a pause whose channel has no calendar", () => {
  plainTest("is refused: extend it with hours / minutes; the pause unchanged", async ({ app }) => {
    await app.ready();
    await execute(app, plainRole.start, ORDER, { threadId: "t-1" });
    const pauseId = plainRole.told.sent.at(-1)?.pauseId ?? "";
    const before = await pauseOf(app, pauseId);

    const refused: unknown = await app
      .extendPause({ pauseId, expiresIn: workingHours(8) }, manager)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(DtoValidationError);
    expect(refused).toMatchObject({
      issues: [{ path: ".expiresIn", reason: expect.stringContaining("no working calendar") }],
    });
    expect(await pauseOf(app, pauseId)).toEqual(before);
    // a plain extension of the same pause is as in #942
    const plain = await app.extendPause({ pauseId, expiresIn: hours(48) }, manager);
    expect(Date.parse(plain.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt ?? ""));
  });
});

const toolDesk = workingToolApp("wt-tool", {
  role: { expiresIn: hours(24) },
  toolExpiresIn: workingHours(4),
  calendar: WorkingWeek.of(TEL_AVIV),
});
const toolTest = testWith(toolDesk.application);

describe("#944: an agent's approval with a working-time deadline of its tool", () => {
  toolTest(
    "the tool's workingHours(4) over the role's plain 24 h, counted by the calendar",
    async ({ app, clock, mockLlm }) => {
      await app.ready();
      // Sunday 2026-01-11 15:00 IST = 13:00Z: 3 h that day (to 18:00), Monday 09:00 + 1 h → 10:00 IST = 08:00Z
      await moveTo(clock, "2026-01-11T13:00:00.000Z");
      mockLlm(toolDesk.agent as never).thenReturn(
        callTool(toolDesk.tool as never, { orderId: "7" } as never),
      );

      await execute(app, toolDesk.start, { orderId: "7" }, { threadId: "t-1" });

      const [open] = (await app.resolve(PausedExecutionRepository).findOpenAfter(undefined, 10))
        .pauses;
      expect(open?.expiresAt).toBe("2026-01-12T08:00:00.000Z");
    },
  );
});
