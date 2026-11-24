/**
 * #944 AC3, AC5: a custom `@WorkingCalendar` class that reads the application's own data (a holiday
 * table) — it sees the pause's tenant and role, runs in the step's frame, is created once by the
 * application's container; a tenant with its own holidays gets deadlines that skip them, another
 * tenant on the default grid does not. A calendar that fails, times out or answers a bad date fails
 * the step that asked: nobody is asked, no pause is recorded; an extension with it is refused and the
 * pause stays. A calendar changed later never moves an open pause.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { Injectable } from "../../src/components/decorators.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import {
  WorkingCalendar,
  WorkingCalendarError,
  WorkingCalendarProblem,
  WorkingWeek,
  type WorkingCalendarHandler,
  type WorkingCalendarContext,
} from "../../src/index.js";
import { QuestionFailedError } from "../../src/flow/runtime/errors.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, seconds, workingHours, workingMinutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { workingApp, workingToolApp } from "../flow/fixtures/working-time-app.js";
import { TEL_AVIV } from "./helpers.js";
import { milliseconds } from "./units.js";

const ORDER = { orderId: "o-1" };
const manager = { actor: { id: "manager-17" } };

async function moveTo(clock: VirtualClock, instant: string): Promise<void> {
  await clock.advance(milliseconds(Date.parse(instant) - clock.now().getTime()));
}

/** The application's own data: the holidays of each tenant. */
@Injectable()
class HolidayRepository {
  readonly tables = new Map<string, string[]>();
  reads: string[] = [];

  holidaysOf(tenantId: string): readonly string[] {
    this.reads.push(tenantId);
    return this.tables.get(tenantId) ?? [];
  }
}

/** What the custom calendars were asked and where they ran. */
const seen = {
  requests: [] as WorkingCalendarContext[],
  tenants: [] as (string | undefined)[],
};

@WorkingCalendar({ name: "tenant-holidays-working-calendar", deps: [HolidayRepository] })
class TenantHolidaysCalendar implements WorkingCalendarHandler {
  constructor(private readonly holidays: HolidayRepository) {}

  addWorkingTime(request: WorkingCalendarContext): Date | Promise<Date> {
    seen.requests.push(request);
    seen.tenants.push(currentFrame()?.execution.tenant.tenantId);
    const grid = WorkingWeek.of({
      ...TEL_AVIV,
      holidays: [...this.holidays.holidaysOf(request.tenantId)],
    });
    return grid.addWorkingTime(request);
  }
}

/** A calendar that misbehaves as the test says. */
const flaky = { mode: "ok" as "ok" | "throw" | "hang" | "past" | "string", calls: 0 };

@WorkingCalendar({ name: "flaky-working-calendar" })
class FlakyCalendar implements WorkingCalendarHandler {
  addWorkingTime(request: WorkingCalendarContext): Date | Promise<Date> {
    flaky.calls += 1;
    if (flaky.mode === "throw") throw new Error("the holiday table of Jane Doe is down");
    if (flaky.mode === "hang") return new Promise<Date>(() => undefined);
    if (flaky.mode === "past") return new Date(request.from);
    if (flaky.mode === "string") return JSON.parse('"tomorrow"') as Date;
    return WorkingWeek.of(TEL_AVIV).addWorkingTime(request);
  }
}

beforeEach(() => {
  seen.requests.length = 0;
  seen.tenants.length = 0;
  flaky.mode = "ok";
  flaky.calls = 0;
});

const pauseOf = async (app: TestApp, pauseId: string, tenantId = "default") => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId(tenantId, pauseId);
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

const holidayDesk = workingApp("hol-desk", {
  role: {
    expiresIn: workingHours(2),
    remindBefore: workingMinutes(45),
    workingCalendar: TenantHolidaysCalendar,
  },
  calendar: WorkingWeek.of(TEL_AVIV),
  providers: [HolidayRepository, TenantHolidaysCalendar],
});
const holiday = testWith(holidayDesk.application);
const sentId = (): string => holidayDesk.told.sent.at(-1)?.pauseId ?? "";

describe("#944 AC3: a tenant's own holiday table", () => {
  beforeEach(() => {
    holidayDesk.told.sent.length = 0;
    holidayDesk.told.expiring.length = 0;
  });

  holiday(
    "AC3: two tenants, one holiday table: acme's Sunday is a holiday, globex's is not",
    async ({ app, clock }) => {
      await app.ready();
      app.resolve(HolidayRepository).tables.set("acme", ["2026-01-11"]);
      await moveTo(clock, "2026-01-08T15:30:00.000Z");

      const acme = await execute(app, holidayDesk.start, ORDER, {
        threadId: "t-1",
        tenant: { tenantId: "acme" },
      });
      const globex = await execute(app, holidayDesk.start, ORDER, {
        threadId: "t-2",
        tenant: { tenantId: "globex" },
      });

      // Thursday 17:30 + 2 h: 30 min that day, then acme skips Sunday: Monday 09:00 + 1.5 h = 10:30 IST (08:30Z)
      expect(acme.pending[0]?.expiresAt).toBe("2026-01-12T08:30:00.000Z");
      expect(globex.pending[0]?.expiresAt).toBe("2026-01-11T08:30:00.000Z");
    },
  );

  holiday(
    "AC3: the calendar sees the tenant and the role, runs in the step's frame, reads its deps",
    async ({ app, clock }) => {
      await app.ready();
      app.resolve(HolidayRepository).tables.set("acme", ["2026-01-11"]);
      await moveTo(clock, "2026-01-08T15:30:00.000Z");

      await execute(app, holidayDesk.start, ORDER, {
        threadId: "t-1",
        tenant: { tenantId: "acme" },
      });

      // the deadline, then the reminder's lead (2 h − 45 min = 75 min)
      expect(seen.requests).toEqual([
        {
          from: new Date("2026-01-08T15:30:00.000Z"),
          amount: workingHours(2),
          tenantId: "acme",
          target: "hol-desk-question",
        },
        {
          from: new Date("2026-01-08T15:30:00.000Z"),
          amount: workingHours(1.25),
          tenantId: "acme",
          target: "hol-desk-question",
        },
      ]);
      expect(seen.tenants).toEqual(["acme", "acme"]);
      expect(app.resolve(HolidayRepository).reads).toEqual(["acme", "acme"]);
      // one instance, created by the application's container
      expect(app.resolve(TenantHolidaysCalendar)).toBe(app.resolve(TenantHolidaysCalendar));
    },
  );

  holiday(
    "a calendar changed later does not move an open pause; the next pause has the new one",
    async ({ app, clock }) => {
      await app.ready();
      await moveTo(clock, "2026-01-08T15:30:00.000Z");
      const first = await execute(app, holidayDesk.start, ORDER, { threadId: "t-1" });
      const firstId = sentId();
      expect(first.pending[0]?.expiresAt).toBe("2026-01-11T08:30:00.000Z");

      // the tenant adds Sunday as a holiday afterwards
      app.resolve(HolidayRepository).tables.set("default", ["2026-01-11"]);
      const second = await execute(app, holidayDesk.start, ORDER, { threadId: "t-2" });

      expect((await pauseOf(app, firstId)).expiresAt).toBe("2026-01-11T08:30:00.000Z");
      expect(second.pending[0]?.expiresAt).toBe("2026-01-12T08:30:00.000Z");
    },
  );

  holiday(
    "AC4: an extension by workingMinutes(30) ≤ remindBefore(45): the calendar is called once, no reminder",
    async ({ app, clock }) => {
      await moveTo(clock, "2026-01-11T07:00:00.000Z");
      await execute(app, holidayDesk.start, ORDER, { threadId: "t-1" });
      const pauseId = sentId();
      // Sunday 09:00 IST: deadline 11:00 IST (09:00Z), reminder at 10:15 IST (08:15Z)
      expect((await pauseOf(app, pauseId)).expiresAt).toBe("2026-01-11T09:00:00.000Z");
      expect((await pauseOf(app, pauseId)).remindAt).toBe("2026-01-11T08:15:00.000Z");
      await moveTo(clock, "2026-01-11T08:50:00.000Z");
      await until(() => holidayDesk.told.expiring.length === 1);
      seen.requests.length = 0;

      const extension = await app.extendPause({ pauseId, expiresIn: workingMinutes(30) }, manager);

      expect(extension.expiresAt).toBe("2026-01-11T09:20:00.000Z");
      expect(seen.requests).toHaveLength(1);
      expect(seen.requests[0]).toMatchObject({ amount: workingMinutes(30), tenantId: "default" });
      expect((await pauseOf(app, pauseId)).remindAt).toBeUndefined();
    },
  );

  holiday(
    "AC4: an extension by workingHours(2) with a reminder: two calls, the reminder at calendar.add(now, 2 h − 45 min)",
    async ({ app, clock }) => {
      await moveTo(clock, "2026-01-11T07:00:00.000Z");
      await execute(app, holidayDesk.start, ORDER, { threadId: "t-1" });
      const pauseId = sentId();
      seen.requests.length = 0;

      const extension = await app.extendPause({ pauseId, expiresIn: workingHours(3) }, manager);

      // now Sunday 09:00 IST + 3 h: 09:00–13:00 is 4 h → 12:00 IST; the reminder 3 h − 45 min = 2.25 h → 11:15 IST
      expect(extension.expiresAt).toBe("2026-01-11T10:00:00.000Z");
      expect((await pauseOf(app, pauseId)).remindAt).toBe("2026-01-11T09:15:00.000Z");
      expect(seen.requests.map((one) => one.amount.amount)).toEqual([hours(3), hours(2.25)]);
    },
  );
});

const flakyDesk = workingApp("flaky-desk", {
  role: { expiresIn: workingHours(2), workingCalendar: FlakyCalendar },
  providers: [FlakyCalendar],
});
const flakyTest = testWith(flakyDesk.application);

describe("#944 AC5: a calendar that cannot answer asks nobody", () => {
  beforeEach(() => {
    flakyDesk.told.sent.length = 0;
  });

  const failureOf = async (app: TestApp): Promise<unknown> => {
    const result = await execute(app, flakyDesk.start, ORDER, { threadId: "t-1" }).catch(
      (error: unknown) => error,
    );
    return result;
  };

  flakyTest(
    "AC5: throws → the step fails with QuestionFailedError, cause a WorkingCalendarError; nobody is asked; no record",
    async ({ app, clock }) => {
      flaky.mode = "throw";
      await moveTo(clock, "2026-01-08T15:30:00.000Z");

      const failed = await failureOf(app);

      expect(failed).toBeInstanceOf(QuestionFailedError);
      const cause = (failed as QuestionFailedError).cause;
      expect(cause).toBeInstanceOf(WorkingCalendarError);
      expect(cause).toMatchObject({
        calendar: "flaky-working-calendar",
        problem: WorkingCalendarProblem.CalendarFailed,
        code: "pause.working-calendar",
      });
      expect((failed as Error).message).not.toContain("Jane Doe");
      expect(flakyDesk.told.sent).toEqual([]);
      expect(
        await app.resolve(PausedExecutionRepository).findOpenAfter(undefined, 10),
      ).toMatchObject({ pauses: [] });
    },
  );

  flakyTest(
    "AC5: a calendar answering the start itself or a non-Date fails the step the same way",
    async ({ app, clock }) => {
      await moveTo(clock, "2026-01-08T15:30:00.000Z");
      for (const [mode, problem] of [
        ["past", WorkingCalendarProblem.NotAfterStart],
        ["string", WorkingCalendarProblem.NotADate],
      ] as const) {
        flaky.mode = mode;
        const failed = await execute(app, flakyDesk.start, ORDER, { threadId: `t-${mode}` }).catch(
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(QuestionFailedError);
        expect((failed as QuestionFailedError).cause).toMatchObject({ problem });
      }
      expect(flakyDesk.told.sent).toEqual([]);
    },
  );

  flakyTest(
    "AC5: a calendar that hangs times out after the tool timeout on the clock",
    async ({ app, clock }) => {
      flaky.mode = "hang";
      await moveTo(clock, "2026-01-08T15:30:00.000Z");
      const running = execute(app, flakyDesk.start, ORDER, { threadId: "t-1" }).catch(
        (error: unknown) => error,
      );

      await until(() => flaky.calls === 1);
      // in steps under the lease (30 s): the step's holder keeps renewing while the calendar hangs
      for (let step = 0; step < 4; step += 1) await clock.advance(seconds(10));
      const failed = await running;

      expect(failed).toBeInstanceOf(QuestionFailedError);
      expect((failed as QuestionFailedError).cause).toMatchObject({
        problem: WorkingCalendarProblem.CalendarTimeout,
      });
      expect(flakyDesk.told.sent).toEqual([]);
    },
  );

  flakyTest(
    "AC5: extendPause with a failing calendar rejects with the WorkingCalendarError, the pause unchanged",
    async ({ app, clock }) => {
      await moveTo(clock, "2026-01-08T15:30:00.000Z");
      const paused = await execute(app, flakyDesk.start, ORDER, { threadId: "t-1" });
      expect(paused.status).toBe(ExecutionStatus.Paused);
      const pauseId = flakyDesk.told.sent[0]?.pauseId ?? "";
      const before = await pauseOf(app, pauseId);
      flaky.mode = "throw";

      const refused: unknown = await app
        .extendPause({ pauseId, expiresIn: workingHours(8) }, manager)
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(WorkingCalendarError);
      expect(refused).toMatchObject({ problem: WorkingCalendarProblem.CalendarFailed });
      expect(await pauseOf(app, pauseId)).toEqual(before);
    },
  );
});

const toolDesk = workingToolApp("flaky-tool", {
  role: { expiresIn: workingHours(2), workingCalendar: FlakyCalendar },
  providers: [FlakyCalendar],
});
const toolTest = testWith(toolDesk.application);

describe("#944 AC5: an agent's approval with a failing calendar", () => {
  toolTest(
    "AC5: the agent step fails with AgentFailedError, cause a WorkingCalendarError; the tool never ran",
    async ({ app, clock, mockLlm }) => {
      flaky.mode = "throw";
      await moveTo(clock, "2026-01-08T15:30:00.000Z");
      mockLlm(toolDesk.agent as never).thenReturn(
        callTool(toolDesk.tool as never, { orderId: "7" } as never),
      );

      const failed: unknown = await execute(
        app,
        toolDesk.start,
        { orderId: "7" },
        { threadId: "t-1" },
      ).catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(AgentFailedError);
      expect((failed as AgentFailedError).cause).toBeInstanceOf(WorkingCalendarError);
      expect(
        await app.resolve(PausedExecutionRepository).findOpenAfter(undefined, 10),
      ).toMatchObject({ pauses: [] });
    },
  );
});
