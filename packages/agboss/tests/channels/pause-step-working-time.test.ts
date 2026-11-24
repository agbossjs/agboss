/**
 * #944 (AC1, AC4, AC5): the record of a pause whose deadline is working time. The calendar is asked
 * once, when the record is made — before the channel is asked — never on a re-entry; the reminder
 * counts working time the same way (`calendar.add(askedAt, expiresIn − remindBefore)`), is kept
 * only strictly between the ask and the clamped deadline, and a calendar that cannot answer asks
 * nobody. Every time is explicit on the virtual clock; the calendar here is a scripted fake.
 */
import { describe, expect, it, vi } from "vitest";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import {
  WorkingCalendarError,
  WorkingCalendarProblem,
  type WorkingCalendarHandler,
  type WorkingCalendarContext,
} from "../../src/index.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { PauseExpiryBound, PauseKind } from "../../src/infrastructure/pause-record.js";
import { pauseStep, type PauseChannel, type PauseStepSite } from "../../src/flow/runtime/pause.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, minutes, seconds, workingHours, workingMinutes } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";

const ASKED = new Date("2026-01-08T15:30:00.000Z");
const at = (delay: number): string => new Date(ASKED.getTime() + delay).toISOString();
const question = {
  kind: PauseKind.Approval,
  step: "desk-clerk-agent",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
};
const answers = {
  savePauseAnswer: (): Promise<void> => Promise.resolve(),
  markPauseAnswerNotTaken: (): Promise<void> => Promise.resolve(),
  findPauseAnswersByTenantIdAndRootExecutionId: () => Promise.resolve([]),
};

/** A calendar scripted by what it answers to each request: its requests are kept. */
function calendarOf(answer: (request: WorkingCalendarContext) => unknown) {
  const requests: WorkingCalendarContext[] = [];
  const frames: unknown[] = [];
  const handler: WorkingCalendarHandler = {
    addWorkingTime: (request) => {
      requests.push(request);
      frames.push(currentFrame());
      return answer(request) as Date | Promise<Date>;
    },
  };
  return { requests, frames, calendar: { name: "fake-working-calendar", handler } };
}

/** The ask of a working deadline: the site, the channel's sends and the log. */
function setup(options: {
  readonly channel: Partial<PauseChannel>;
  readonly calendar: PauseChannel["calendar"];
  readonly deadlineAt?: string;
}) {
  const clock = new VirtualClock(ASKED);
  const pauses = new InMemoryPausedExecutionRepository();
  const sends: unknown[] = [];
  const warn = vi.fn();
  const base = testFrame();
  const frame =
    options.deadlineAt === undefined
      ? base
      : {
          ...base,
          execution: {
            ...base.execution,
            deadline: { at: options.deadlineAt, deadline: 0 as never },
          },
        };
  const channel: PauseChannel = {
    name: "refund-approval-channel",
    answerer: PauseAnswerer.Channel,
    sender: {
      send: () => {
        sends.push(1);
        return Promise.resolve(ChannelOutcome.awaitReply());
      },
    },
    calendar: options.calendar,
    ...options.channel,
  };
  const site: PauseStepSite = {
    pauses,
    answers,
    channel,
    frame,
    signal: undefined,
    clock,
    validate: (decision) => decision,
    onSend: () => Promise.resolve(),
    log: { info: vi.fn(), warn, error: vi.fn() },
  };
  const records = async () =>
    pauses.findAllByTenantIdAndRootExecutionId("default", frame.execution.executionId);
  // the first entry stops at its interrupt: outside a graph it throws
  const enter = (extra: Partial<typeof question & { expiresIn: never }> = {}) =>
    pauseStep(site, { ...question, ...extra }).catch((error: unknown) => error);
  return { clock, site, sends, warn, records, enter, pauses };
}

describe("#944 AC1, AC4: the record of a working deadline", () => {
  it("AC1: the calendar is asked for askedAt + the working amount, as the pause's tenant and role", async () => {
    const calendar = calendarOf(() => new Date(at(25 * 3_600_000)));
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(2) },
      calendar: calendar.calendar,
    });

    await enter();

    expect(calendar.requests).toEqual([
      {
        from: ASKED,
        amount: workingHours(2),
        tenantId: "default",
        target: "refund-approval-channel",
      },
    ]);
    const [pause] = await records();
    expect(pause).toMatchObject({
      askedAt: ASKED.toISOString(),
      expiresAt: at(25 * 3_600_000),
      expiryBound: PauseExpiryBound.Pause,
    });
  });

  it("AC1: it is asked in the step's frame (its ExecutionContext: tenant, fields)", async () => {
    const calendar = calendarOf(() => new Date(at(hours(30))));
    const { enter, site } = setup({
      channel: { expiresIn: workingHours(2) },
      calendar: calendar.calendar,
    });

    await enter();

    expect(calendar.frames).toHaveLength(1);
    expect(
      (calendar.frames[0] as { execution: { executionId: string } }).execution.executionId,
    ).toBe(site.frame.execution.executionId);
  });

  it("AC1: a step's own expiresIn works over the role's; a calendar that answers synchronously works", async () => {
    const calendar = calendarOf(
      (request) => new Date(request.from.getTime() + request.amount.amount * 3),
    );
    const { enter, records } = setup({
      channel: { expiresIn: hours(24) },
      calendar: calendar.calendar,
    });

    await enter({ expiresIn: workingMinutes(30) as never });

    expect(calendar.requests.map((request) => request.amount.amount)).toEqual([minutes(30)]);
    expect((await records())[0]?.expiresAt).toBe(at(minutes(90)));
  });

  it("AC4: expiresIn and remindBefore both working: remindAt = calendar.add(askedAt, expiresIn − remindBefore)", async () => {
    const calendar = calendarOf(
      (request) =>
        // the deadline (3 h of working time) in 30 h, the reminder (the 2 h lead) in 26 h: the calendar's own arithmetic
        new Date(
          request.from.getTime() + (request.amount.amount === hours(3) ? hours(30) : hours(26)),
        ),
    );
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3), remindBefore: workingHours(1) },
      calendar: calendar.calendar,
    });

    await enter();

    expect(calendar.requests.map((request) => request.amount.amount)).toEqual([hours(3), hours(2)]);
    const [pause] = await records();
    expect(pause?.expiresAt).toBe(at(hours(30)));
    expect(pause?.remindAt).toBe(at(hours(26)));
  });

  it("AC4: working expiresIn with a plain remindBefore: expiresAt − remindBefore, one calendar call", async () => {
    const calendar = calendarOf(() => new Date(at(hours(30))));
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3), remindBefore: hours(2) },
      calendar: calendar.calendar,
    });

    await enter();

    expect(calendar.requests).toHaveLength(1);
    expect((await records())[0]?.remindAt).toBe(at(hours(28)));
  });

  it("AC4: a step override no longer than the role's reminder: no reminder, no second calendar call", async () => {
    const calendar = calendarOf(() => new Date(at(hours(5))));
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3), remindBefore: workingHours(1) },
      calendar: calendar.calendar,
    });

    await enter({ expiresIn: workingMinutes(60) as never });

    expect(calendar.requests).toHaveLength(1);
    expect((await records())[0]?.remindAt).toBeUndefined();
  });

  it("AC4: a working remindBefore with a plain expiresIn gets no reminder (the assembly refuses it before)", async () => {
    const calendar = calendarOf(() => new Date(at(hours(5))));
    const { enter, records } = setup({
      channel: { expiresIn: hours(4), remindBefore: workingHours(1) },
      calendar: calendar.calendar,
    });

    await enter();

    expect(calendar.requests).toHaveLength(0);
    expect((await records())[0]?.remindAt).toBeUndefined();
  });

  it("AC4: plain durations never ask the calendar (#941/#942 as before)", async () => {
    const calendar = calendarOf(() => new Date(at(hours(5))));
    const { enter, records } = setup({
      channel: { expiresIn: hours(4), remindBefore: hours(1) },
      calendar: calendar.calendar,
    });

    await enter();

    expect(calendar.requests).toHaveLength(0);
    expect((await records())[0]).toMatchObject({ expiresAt: at(hours(4)), remindAt: at(hours(3)) });
  });

  it("AC4: remindAt dropped when the run's deadline clamps expiresAt at or below it", async () => {
    // the calendar says 30 h (deadline) and 26 h (reminder); the run's deadline is 20 h away
    const calendar = calendarOf(
      (request) =>
        new Date(
          request.from.getTime() + (request.amount.amount === hours(3) ? hours(30) : hours(26)),
        ),
    );
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3), remindBefore: workingHours(1) },
      calendar: calendar.calendar,
      deadlineAt: at(hours(20)),
    });

    await enter();

    expect((await records())[0]).toMatchObject({
      expiresAt: at(hours(20)),
      expiryBound: PauseExpiryBound.RunDeadline,
    });
    expect((await records())[0]?.remindAt).toBeUndefined();
  });

  it("AC4: remindAt kept when it is still before the clamped deadline", async () => {
    const calendar = calendarOf(
      (request) =>
        new Date(
          request.from.getTime() + (request.amount.amount === hours(3) ? hours(30) : hours(26)),
        ),
    );
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3), remindBefore: workingHours(1) },
      calendar: calendar.calendar,
      deadlineAt: at(hours(27)),
    });

    await enter();

    expect((await records())[0]).toMatchObject({
      expiresAt: at(hours(27)),
      remindAt: at(hours(26)),
    });
  });

  it("AC4: a lead the calendar answers at or before the ask is the calendar's failure (not-after-start), nobody is asked", async () => {
    const calendar = calendarOf((request) =>
      request.amount.amount === hours(2) ? new Date(at(0)) : new Date(at(hours(30))),
    );
    const { enter } = setup({
      channel: { expiresIn: workingHours(3), remindBefore: workingHours(1) },
      calendar: calendar.calendar,
    });

    // the lead's answer is not after askedAt: the calendar contract refuses it (`not-after-start`)
    expect(await enter()).toBeInstanceOf(WorkingCalendarError);
  });

  it("the run-deadline tie rule (#941 D8) holds under working time: a deadline equal to the run's goes to the run", async () => {
    const calendar = calendarOf(() => new Date(at(hours(30))));
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3) },
      calendar: calendar.calendar,
      deadlineAt: at(hours(30)),
    });

    await enter();

    expect((await records())[0]).toMatchObject({
      expiresAt: at(hours(30)),
      expiryBound: PauseExpiryBound.RunDeadline,
      boundAt: at(hours(30)),
    });
  });

  it("a working deadline later than the run's: the run's wins, no error", async () => {
    const calendar = calendarOf(() => new Date(at(hours(100))));
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3) },
      calendar: calendar.calendar,
      deadlineAt: at(hours(10)),
    });

    await enter();

    expect((await records())[0]).toMatchObject({
      expiresAt: at(hours(10)),
      expiryBound: PauseExpiryBound.RunDeadline,
    });
  });

  it("a working deadline earlier than the run's keeps its own bound and the run's as boundAt", async () => {
    const calendar = calendarOf(() => new Date(at(hours(5))));
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(3) },
      calendar: calendar.calendar,
      deadlineAt: at(hours(10)),
    });

    await enter();

    expect((await records())[0]).toMatchObject({
      expiresAt: at(hours(5)),
      expiryBound: PauseExpiryBound.Pause,
      boundAt: at(hours(10)),
    });
  });

  it("a re-entry finds the record: the calendar is never asked again, a deploy changing it moves nothing", async () => {
    const calendar = calendarOf(() => new Date(at(hours(30))));
    const { enter, records, site } = setup({
      channel: { expiresIn: workingHours(3), remindBefore: workingHours(1) },
      calendar: calendar.calendar,
    });
    await enter();
    const [first] = await records();
    const asked = calendar.requests.length;

    // the same step again, its calendar now answering something else
    const changed = calendarOf(() => new Date(at(hours(99))));
    Object.assign(site, { channel: { ...site.channel, calendar: changed.calendar } });
    await enter();

    expect(calendar.requests).toHaveLength(asked);
    expect(changed.requests).toHaveLength(0);
    expect((await records())[0]).toEqual(first);
  });
});

describe("#944 AC5: a calendar that cannot answer asks nobody", () => {
  const failing = async (answer: (request: WorkingCalendarContext) => unknown) => {
    const calendar = calendarOf(answer);
    const world = setup({ channel: { expiresIn: workingHours(2) }, calendar: calendar.calendar });
    const failed = await world.enter();
    return { ...world, calendar, failed };
  };

  it("AC5: throws → WorkingCalendarError calendar-failed, no send, no record; its message has no calendar text", async () => {
    const { failed, sends, records, warn } = await failing(() => {
      throw new Error("holiday table for patient Jane Doe is gone");
    });

    expect(failed).toBeInstanceOf(WorkingCalendarError);
    expect(failed).toMatchObject({
      code: "pause.working-calendar",
      calendar: "fake-working-calendar",
      problem: WorkingCalendarProblem.CalendarFailed,
    });
    expect((failed as Error).message).not.toContain("Jane Doe");
    expect((failed as Error).message).toBe(
      "working calendar fake-working-calendar: calendar-failed",
    );
    expect(sends).toHaveLength(0);
    expect(await records()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "pause.working-calendar-failed",
      "working calendar fake-working-calendar: calendar-failed",
      expect.objectContaining({ tenantId: "default" }),
    );
  });

  it("AC5: rejects (async) → calendar-failed, the error as cause only in-process", async () => {
    const { failed } = await failing(() => Promise.reject(new Error("db down")));
    expect(failed).toMatchObject({ problem: WorkingCalendarProblem.CalendarFailed });
    expect((failed as Error).cause).toEqual(new Error("db down"));
  });

  it("AC5: times out after the tool timeout on the clock → calendar-timeout, no send, no record", async () => {
    const calendar = calendarOf(() => new Promise<Date>(() => undefined));
    const { clock, site, sends, records } = setup({
      channel: { expiresIn: workingHours(2) },
      calendar: calendar.calendar,
    });
    const pending = pauseStep(site, question).catch((error: unknown) => error);

    await clock.advance(seconds(29));
    expect(sends).toHaveLength(0);
    await clock.advance(seconds(2));
    const failed = await pending;

    expect(failed).toMatchObject({
      problem: WorkingCalendarProblem.CalendarTimeout,
      code: "pause.working-calendar",
    });
    expect(sends).toHaveLength(0);
    expect(await records()).toHaveLength(0);
  });

  it.each([
    ["a string", "2026-01-09T10:00:00.000Z"],
    ["a number", 1_767_952_800_000],
    ["an invalid Date", new Date("not a date")],
    ["nothing", undefined],
    ["null", null],
  ])("AC5: answers %s → not-a-date", async (_label, value) => {
    const { failed, sends, records } = await failing(() => value);
    expect(failed).toMatchObject({ problem: WorkingCalendarProblem.NotADate });
    expect(sends).toHaveLength(0);
    expect(await records()).toHaveLength(0);
  });

  it.each([
    ["exactly from", () => new Date(ASKED)],
    ["before from", () => new Date(ASKED.getTime() - 1)],
  ])("AC5: answers %s → not-after-start", async (_label, answer) => {
    const { failed, sends } = await failing(answer);
    expect(failed).toMatchObject({ problem: WorkingCalendarProblem.NotAfterStart });
    expect(sends).toHaveLength(0);
  });

  it("AC5: one millisecond after from is accepted", async () => {
    const calendar = calendarOf(() => new Date(ASKED.getTime() + 1));
    const { enter, records } = setup({
      channel: { expiresIn: workingHours(2) },
      calendar: calendar.calendar,
    });
    await enter();
    expect((await records())[0]?.expiresAt).toBe(at(1));
  });

  it("AC5: the re-entry of a step whose calendar failed asks the calendar again", async () => {
    let healthy = false;
    const calendar = calendarOf(() => {
      if (!healthy) throw new Error("down");
      return new Date(at(hours(30)));
    });
    const { enter, records, sends } = setup({
      channel: { expiresIn: workingHours(2) },
      calendar: calendar.calendar,
    });

    expect(await enter()).toBeInstanceOf(WorkingCalendarError);
    healthy = true;
    await enter();

    expect(calendar.requests).toHaveLength(2);
    expect(await records()).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  it("the instance's stop is not a calendar failure: the abort rises as it is", async () => {
    const stop = new AbortController();
    const calendar = calendarOf(() => new Promise<Date>(() => undefined));
    const { site, clock, records } = setup({
      channel: { expiresIn: workingHours(2) },
      calendar: calendar.calendar,
    });
    const pending = pauseStep({ ...site, signal: stop.signal }, question).catch(
      (error: unknown) => error,
    );

    await clock.advance(seconds(1));
    stop.abort(new Error("the instance stops"));
    const failed = await pending;

    expect(failed).not.toBeInstanceOf(WorkingCalendarError);
    expect(await records()).toHaveLength(0);
  });

  it("a working deadline for a channel without any calendar is a programming error (the assembly refuses it first)", async () => {
    const { enter } = setup({ channel: { expiresIn: workingHours(2) }, calendar: undefined });
    expect(await enter()).toBeInstanceOf(TypeError);
  });
});
