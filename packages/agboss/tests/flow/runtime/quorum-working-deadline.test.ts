import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { testWith } from "../../../src/testing/index.js";
import type { VirtualClock } from "../../../src/testing/clock.js";
import { milliseconds } from "../../calendar/units.js";
import { answerOf, execute } from "../../helpers/flow.js";
import {
  ContractRejectedWorkflowFinish,
  ContractSignedWorkflowFinish,
} from "../fixtures/committee.fixture.js";
import {
  AuditApplication,
  AuditBrokenWorkflowStart,
  AuditDaysWorkflowStart,
  AuditGroupsWorkflowStart,
  AuditHoursWorkflowStart,
  AuditUnhandledWorkflowStart,
  CalendarLog,
} from "../fixtures/quorum-working-deadline.fixture.js";

/**
 * #1306: a quorum join whose `deadline` is working time, counted by the quorum's own
 * `@WorkingCalendar`. The branches' pauses are bounded by it (their own deadline is 30 days), so a
 * pause's `expiresAt` is where the quorum's calendar put the deadline. The virtual clock starts
 * Monday 2026-01-05 09:00Z and is moved to explicit instants; Tel Aviv's office is Sunday to
 * Thursday 09:00–18:00 (UTC+2 in January), lunch 13:00–14:00.
 */

const test = testWith(AuditApplication);
const owner = { ownerId: "alice" };
const contract = { text: "supply" };

async function moveTo(clock: VirtualClock, instant: string): Promise<void> {
  await clock.advance(milliseconds(Date.parse(instant) - clock.now().getTime()));
}

describe("#1306: the quorum's deadline in working time bounds its branches' pauses", () => {
  test("asked Thursday 17:30 in Tel Aviv, workHours(2) is Sunday 10:30: every pause expires then", async ({
    app,
    clock,
  }) => {
    await moveTo(clock, "2026-01-08T15:30:00.000Z");

    const paused = await execute(app, AuditHoursWorkflowStart, contract, owner);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending.map((pause) => pause.expiresAt)).toEqual([
      "2026-01-11T08:30:00.000Z",
      "2026-01-11T08:30:00.000Z",
    ]);
  });

  test("workDays(1) from Sunday 09:00 is that day's end (18:00), not 24 hours later", async ({
    app,
    clock,
  }) => {
    await moveTo(clock, "2026-01-11T07:00:00.000Z");

    const paused = await execute(app, AuditDaysWorkflowStart, contract, owner);

    expect(paused.pending[0]?.expiresAt).toBe("2026-01-11T16:00:00.000Z");
  });

  test("the pauses are asked once: the deadline is counted at dispatch, and an answer goes on", async ({
    app,
    clock,
  }) => {
    await moveTo(clock, "2026-01-11T07:00:00.000Z");
    const paused = await execute(app, AuditHoursWorkflowStart, contract, owner);

    const done = await app.resume(answerOf(paused, { approved: true }, 0), owner);

    expect(done).toFinishWith(ContractSignedWorkflowFinish, { status: "signed" });
  });

  test("the same in .joinQuorumGroups(…)", async ({ app, clock }) => {
    await moveTo(clock, "2026-01-08T15:30:00.000Z");

    const paused = await execute(app, AuditGroupsWorkflowStart, contract, owner);

    expect(paused.pending.map((pause) => pause.expiresAt)).toEqual([
      "2026-01-11T08:30:00.000Z",
      "2026-01-11T08:30:00.000Z",
    ]);
  });

  test("the deadline is exact: a pause answers until Sunday 10:30 Tel Aviv, and is closed as expired from then", async ({
    app,
    clock,
  }) => {
    await moveTo(clock, "2026-01-08T15:30:00.000Z");
    const paused = await execute(app, AuditHoursWorkflowStart, contract, owner);

    // the weekend passes (wall-clock days; working time has not run out)
    await moveTo(clock, "2026-01-11T08:29:00.000Z");
    const stillOpen = await app.resume(answerOf(paused, { approved: false, note: "no" }, 0), owner);
    expect(stillOpen.status).toBe(ExecutionStatus.Paused);
    await moveTo(clock, "2026-01-11T08:30:01.000Z");

    await expect(app.resume(answerOf(paused, { approved: true }, 1), owner)).rejects.toThrow(
      "expired at 2026-01-11T08:30:00.000Z",
    );
  });
});

describe("#1306: a calendar that cannot answer is PauseError.WorkingCalendar", () => {
  test("the join's .onError(PauseError.WorkingCalendar, …) takes it: no branch is dispatched, no pause opened", async ({
    app,
  }) => {
    const result = await execute(app, AuditBrokenWorkflowStart, contract, {
      ...owner,
      includeRecord: true,
    });

    expect(result).toFinishWith(ContractRejectedWorkflowFinish, { text: "supply" });
    expect(result.record?.lastError).toMatchObject({ code: "pause.working-calendar" });
    expect(result.record?.lastError?.message).not.toContain("holiday table");
    expect(app.resolve(CalendarLog).asked).toHaveLength(1);
    expect(app.resolve(CalendarLog).asked[0]).toMatchObject({ tenantId: "default" });
  });

  test("without a handler the execution fails with the error", async ({ app }) => {
    const failed = execute(app, AuditUnhandledWorkflowStart, contract, owner);

    await expect(failed).rejects.toMatchObject({ code: "pause.working-calendar" });
  });
});
