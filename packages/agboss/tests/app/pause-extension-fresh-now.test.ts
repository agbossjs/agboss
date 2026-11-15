/**
 * #1148: `extendPause` with working time asks a calendar that may take seconds (30 s at most). The
 * extension is decided at the instant of its write, as a plain one is (#942, #1099): a deadline that
 * passed while the calendar computed is not moved, whatever the clock said when the call began. The
 * working deadline itself still counts from the call's start. Tel Aviv, IST = UTC+2 in November: the
 * pause opens Thursday 2026-11-19 17:30 (15:30Z), 2 working hours → Sunday 10:30 (08:30:00Z).
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { PauseClosedError } from "../../src/app/pause-closed-error.js";
import {
  WorkingCalendar,
  WorkingWeek,
  type WorkingCalendarHandler,
  type WorkingTimeRequest,
} from "../../src/index.js";
import { PauseStatus } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds, workingHours } from "../../src/units/index.js";
import type { Milliseconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { workingApp } from "../flow/fixtures/working-time-app.js";
import { TEL_AVIV } from "../calendar/helpers.js";
import { milliseconds } from "../calendar/units.js";

const ORDER = { orderId: "o-1" };
const manager = { answeredBy: "manager-17" };
const DEADLINE = "2026-11-22T08:30:00.000Z";

/** The calendar's slowness: how long the next call takes on the virtual clock (once). */
const slow = {
  clock: undefined as VirtualClock | undefined,
  takes: undefined as Milliseconds | undefined,
};

@WorkingCalendar({ name: "slow-working-calendar" })
class SlowCalendar implements WorkingCalendarHandler {
  async addWorkingTime(request: WorkingTimeRequest): Promise<Date> {
    const takes = slow.takes;
    slow.takes = undefined;
    if (takes !== undefined) await slow.clock?.advance(takes);
    return WorkingWeek.of(TEL_AVIV).addWorkingTime(request);
  }
}

/** The channel's `onPauseExpired`: counted, then held until the test lets it go. */
const expiry = { entered: 0, gate: Promise.resolve() };

const desk = workingApp("fresh-now-desk", {
  role: { expiresIn: workingHours(2), workingCalendar: SlowCalendar },
  calendar: WorkingWeek.of(TEL_AVIV),
  providers: [SlowCalendar],
  onExpired: async () => {
    expiry.entered += 1;
    await expiry.gate;
    return PauseExpiration.fail();
  },
});
const test = testWith(desk.application);

beforeEach(() => {
  desk.told.sent.length = 0;
  slow.takes = undefined;
  expiry.entered = 0;
  expiry.gate = Promise.resolve();
});

const pauseOf = async (app: TestApp, pauseId: string) => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId("default", pauseId);
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

async function moveTo(clock: VirtualClock, instant: string): Promise<void> {
  await clock.advance(milliseconds(Date.parse(instant) - clock.now().getTime()));
}

/** The pause open Thursday 17:30 Tel Aviv, and the clock at `at`; the next calendar call takes `takes`. */
async function pausedThenSlow(
  app: TestApp,
  clock: VirtualClock,
  at: string,
  takes: Milliseconds,
): Promise<string> {
  await app.ready();
  slow.clock = clock;
  await moveTo(clock, "2026-11-19T15:30:00.000Z");
  await execute(app, desk.start, ORDER, { threadId: "t-1" });
  const pauseId = desk.told.sent.at(-1)?.pauseId ?? "";
  expect((await pauseOf(app, pauseId)).expiresAt).toBe(DEADLINE);
  await moveTo(clock, at);
  slow.takes = takes;
  return pauseId;
}

describe("#1148: an extension in working time is decided when it is written", () => {
  test("a deadline that passes while the calendar computes is not moved: PauseClosedError, the deadline unchanged", async ({
    app,
    clock,
  }) => {
    const pauseId = await pausedThenSlow(app, clock, "2026-11-22T08:29:50.000Z", seconds(20));
    let release: () => void = () => undefined;
    expiry.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // the clock passes the deadline inside the calendar; the expiry look enters the channel's handler
    const refused: unknown = await app
      .extendPause({ pauseId, expiresIn: workingHours(8) }, manager)
      .catch((error: unknown) => error);
    await until(() => expiry.entered === 1);
    release();

    expect(clock.now().toISOString()).toBe("2026-11-22T08:30:10.000Z");
    expect(refused).toBeInstanceOf(PauseClosedError);
    await until(async () => (await pauseOf(app, pauseId)).status !== PauseStatus.Pending);
    expect((await pauseOf(app, pauseId)).expiresAt).toBe(DEADLINE);
  });

  test("a slow calendar that answers before the deadline: the extension counts from the call's start", async ({
    app,
    clock,
  }) => {
    const pauseId = await pausedThenSlow(app, clock, "2026-11-22T08:00:00.000Z", seconds(20));

    const extension = await app.extendPause({ pauseId, expiresIn: workingHours(8) }, manager);

    // 08:00:00Z = Sunday 10:00 IST + 8 working hours (10:00–13:00, 14:00–18:00 = 7 h, 09:00–10:00 Monday)
    expect(extension.previousExpiresAt).toBe(DEADLINE);
    expect(extension.expiresAt).toBe("2026-11-23T08:00:00.000Z");
    expect((await pauseOf(app, pauseId)).expiresAt).toBe("2026-11-23T08:00:00.000Z");
  });
});
