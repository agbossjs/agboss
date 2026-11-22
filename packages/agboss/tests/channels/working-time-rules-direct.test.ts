/**
 * #1366: the assembly rules of working time (#944) called directly: a calendar for every working duration, a reminder
 * in working time only before a deadline in working time, a span a calendar can reach within 25 years, on the role and
 * on the override of a tool or a question step. The shard `assembly-rules` mutates `working-time-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { ChannelRole, PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import type { ChannelUse } from "../../src/channels/discovery.js";
import { workingTimeViolations } from "../../src/channels/working-time-rules.js";
import type { Class } from "../../src/components/injection.js";
import { Weekday, WorkingWeek, type WorkingCalendarSource } from "../../src/index.js";
import { hours, workingHours, workingMinutes } from "../../src/units/index.js";
import type { TimeSpan } from "../../src/units/working-time.js";
import { TEL_AVIV } from "../calendar/helpers.js";
import { PurchaseQuestionDto, SpendingLimitAnswerDto } from "../flow/fixtures/questions.fixture.js";

const OFFICE = WorkingWeek.of(TEL_AVIV);
/** One working minute a week: 25 years reach about 1300 of them. */
const SPARSE = WorkingWeek.of({
  timeZone: "Asia/Jerusalem",
  days: [Weekday.Monday],
  hours: [{ from: "09:00", to: "09:01" }],
});

function roleWith(name: string, extra: Record<string, unknown> = {}): Class {
  @ChannelRole({
    name,
    description: "d",
    ask: PurchaseQuestionDto,
    answer: SpendingLimitAnswerDto,
    answerer: PauseAnswerer.ThreadOwner,
    maxVisits: 2,
    ...extra,
  })
  abstract class SomeQuestion extends ChannelOf<SomeQuestion> {}
  return SomeQuestion;
}

const useOf = (channel: Class, expiresIn?: TimeSpan, tool = "ask-tool"): ChannelUse => ({
  tool,
  toolInput: PurchaseQuestionDto,
  channel,
  workflow: "w-workflow",
  isQuestion: true,
  ...(expiresIn === undefined ? {} : { expiresIn }),
});

const found = (uses: readonly ChannelUse[], calendar?: WorkingCalendarSource) =>
  workingTimeViolations(uses, [], calendar).map(({ code, message, nodes }) => ({
    code,
    message,
    nodes,
  }));

const noCalendar = (site: string, role: string) => ({
  code: "channel.working-time-without-calendar",
  message: `${site}: working time needs a calendar, but ${role} has none and the application sets no workingCalendar — set @Application({ workingCalendar }) or @ChannelRole({ workingCalendar })`,
  nodes: [site],
});

const plainDeadline = (site: string, role: string) => ({
  code: "channel.remind-before-working-without-working-expiry",
  message: `${site}: expiresIn is plain time but ${role}'s remindBefore is working time — a calendar cannot subtract: give expiresIn in workingHours / workingMinutes, or remindBefore in plain time`,
  nodes: [site],
});

describe("#1366: a calendar for a role's working time", () => {
  it("names a working deadline or reminder with no calendar anywhere", () => {
    expect(found([useOf(roleWith("a-channel", { expiresIn: workingHours(2) }))])).toEqual([
      noCalendar("a-channel", "a-channel"),
    ]);
    expect(found([useOf(roleWith("b-channel", { remindBefore: workingHours(1) }))])).toEqual([
      noCalendar("b-channel", "b-channel"),
    ]);
  });

  it("accepts it with the role's own calendar, the application's, or in plain time", () => {
    const own = roleWith("c-channel", { expiresIn: workingHours(2), workingCalendar: OFFICE });

    expect(found([useOf(own)])).toEqual([]);
    expect(found([useOf(roleWith("d-channel", { expiresIn: workingHours(2) }))], OFFICE)).toEqual(
      [],
    );
    expect(
      found([useOf(roleWith("e-channel", { expiresIn: hours(2), remindBefore: hours(1) }))]),
    ).toEqual([]);
    expect(found([])).toEqual([]);
  });
});

describe("#1366: a working reminder before a plain deadline", () => {
  it("names it, by the role, and not a working deadline or none", () => {
    const calendar = { workingCalendar: OFFICE };

    expect(
      found([
        useOf(
          roleWith("f-channel", {
            ...calendar,
            expiresIn: hours(4),
            remindBefore: workingHours(1),
          }),
        ),
      ]),
    ).toEqual([plainDeadline("f-channel", "f-channel")]);
    expect(
      found([
        useOf(
          roleWith("g-channel", {
            ...calendar,
            expiresIn: workingHours(4),
            remindBefore: workingHours(1),
          }),
        ),
      ]),
    ).toEqual([]);
    expect(
      found([useOf(roleWith("h-channel", { ...calendar, remindBefore: workingHours(1) }))]),
    ).toEqual([]);
  });
});

describe("#1366: the override of a tool or a question step", () => {
  it("names a working override with no calendar, by the tool and the role", () => {
    const role = roleWith("i-channel");

    expect(found([useOf(role, workingHours(2), "own-tool")])).toEqual([
      noCalendar("own-tool", "i-channel"),
    ]);
    expect(
      found([useOf(roleWith("j-channel", { workingCalendar: OFFICE }), workingHours(2))]),
    ).toEqual([]);
    expect(found([useOf(role, workingHours(2))], OFFICE)).toEqual([]);
    expect(found([useOf(role, hours(2))])).toEqual([]);
    expect(found([useOf(role)])).toEqual([]);
  });

  it("names a plain override of a role whose reminder is working time", () => {
    const role = roleWith("k-channel", { workingCalendar: OFFICE, remindBefore: workingHours(1) });

    expect(found([useOf(role, hours(4), "own-tool")])).toEqual([
      plainDeadline("own-tool", "k-channel"),
    ]);
    expect(found([useOf(role, workingHours(4), "own-tool")])).toEqual([]);
    expect(found([useOf(roleWith("l-channel", { workingCalendar: OFFICE }), hours(4))])).toEqual(
      [],
    );
  });

  it("reads a channel that is no role by the tool", () => {
    class Plain {
      readonly fixture = true;
    }

    expect(found([useOf(Plain, workingHours(2), "bare-tool")])).toEqual([
      noCalendar("bare-tool", "bare-tool"),
    ]);
    expect(found([useOf(Plain, hours(2), "bare-tool")])).toEqual([]);
  });
});

describe("#1366: the working time a calendar reaches", () => {
  it("names a deadline and a reminder past the reach of the role's grid, each by the role", () => {
    const role = roleWith("m-channel", {
      workingCalendar: SPARSE,
      expiresIn: workingMinutes(2000),
      remindBefore: workingMinutes(1999),
    });
    const spans = found([useOf(role)]).map((one) => one.message);

    expect(spans).toEqual([
      "m-channel: 120000000 ms of working time is more working time than its calendar reaches in 25 years",
      "m-channel: 119940000 ms of working time is more working time than its calendar reaches in 25 years",
    ]);
  });

  it("reads the application's grid when the role has none, and its own over it", () => {
    const role = roleWith("n-channel", { expiresIn: workingMinutes(2000) });

    expect(found([useOf(role)], SPARSE)).toHaveLength(1);
    expect(
      found(
        [
          useOf(
            roleWith("o-channel", { expiresIn: workingMinutes(2000), workingCalendar: OFFICE }),
          ),
        ],
        SPARSE,
      ),
    ).toEqual([]);
    expect(
      found(
        [useOf(roleWith("p-channel", { expiresIn: workingMinutes(10), workingCalendar: SPARSE }))],
        OFFICE,
      ),
    ).toEqual([]);
  });

  it("names an override past the reach, by the tool, with the role's grid before the application's", () => {
    const role = roleWith("q-channel", { workingCalendar: SPARSE });

    expect(found([useOf(role, workingMinutes(2000), "far-tool")]).map((one) => one.nodes)).toEqual([
      ["far-tool"],
    ]);
    expect(
      found(
        [
          useOf(
            roleWith("r-channel", { workingCalendar: OFFICE }),
            workingMinutes(2000),
            "far-tool",
          ),
        ],
        SPARSE,
      ),
    ).toEqual([]);
    expect(
      found([useOf(roleWith("s-channel"), workingMinutes(2000), "far-tool")], SPARSE),
    ).toHaveLength(1);
  });

  it("leaves a calendar class and a plain span to the call", () => {
    class Mine {
      readonly fixture = true;
    }
    const role = roleWith("t-channel", { workingCalendar: Mine, expiresIn: workingMinutes(2000) });

    expect(found([useOf(role)]).filter((one) => one.message.includes("reaches"))).toEqual([]);
    expect(
      found([useOf(roleWith("u-channel", { workingCalendar: SPARSE, expiresIn: hours(5000) }))]),
    ).toEqual([]);
  });
});
