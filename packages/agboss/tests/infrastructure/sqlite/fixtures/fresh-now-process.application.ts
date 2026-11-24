import { Application } from "../../../../src/application/application.js";
import { PauseExpiration } from "../../../../src/channels/pause-expiration.js";
import {
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
  Weekday,
  WorkingCalendar,
  WorkingWeek,
  type WorkingCalendarHandler,
  type WorkingCalendarContext,
} from "../../../../src/index.js";
import { SqliteCheckpointSaver } from "../../../../src/internal.js";
import { seconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { workingParts } from "../../../flow/fixtures/working-time-app.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/**
 * #1148 — one question role with a plain 2 s deadline and a working calendar that really takes 3 s once
 * `fresh.slow` is set; its expiry handler is entered, counted and held until `fresh.release()` (at most 20 s).
 * On the SQLite file with the real lease store, for the child process of the real-clock test.
 */
export const fresh = {
  slow: false,
  expired: 0,
  release: (): void => undefined,
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = new Promise<void>((resolve) => {
  fresh.release = resolve;
});

@WorkingCalendar({ name: "real-slow-working-calendar" })
class RealSlowCalendar implements WorkingCalendarHandler {
  async addWorkingTime(request: WorkingCalendarContext): Promise<Date> {
    if (fresh.slow) await sleep(3000);
    return WorkingWeek.of({
      timeZone: "UTC",
      days: Object.values(Weekday).filter((day) => typeof day === "number"),
      hours: [{ from: "00:00", to: "24:00" }],
    }).addWorkingTime(request);
  }
}

export const desk = workingParts("real-fresh-now", {
  role: { expiresIn: seconds(2), workingCalendar: RealSlowCalendar },
  onExpired: async () => {
    fresh.expired += 1;
    await Promise.race([gate, sleep(20_000)]);
    return PauseExpiration.fail();
  },
});

@Application({
  name: "sqlite-fresh-now-process-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [desk.workflow],
  budgets: TEST_BUDGETS,
  providers: [
    desk.channel,
    RealSlowCalendar,
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
  ],
})
export class SqliteFreshNowProcessApplication {}
