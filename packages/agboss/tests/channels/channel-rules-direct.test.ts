/**
 * #1366: the assembly rules of channels on a deadline, a reminder and a visit count, called directly with the roles a
 * workflow names: each violation's code, exact message and nodes, the bounds of a duration (plain and working time),
 * which providers implement a role and a reply interpreter shared by two roles. The shard `assembly-rules` mutates
 * `channel-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { ChannelRole, PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import {
  channelRuleViolations,
  implementationsOf,
  isExpiresIn,
  isNotShorter,
  isRemindBefore,
  sharedInterpreterViolations,
} from "../../src/channels/channel-rules.js";
import type { ChannelUse } from "../../src/channels/discovery.js";
import type { Class } from "../../src/components/injection.js";
import { hours, seconds, workDays, workingHours, workingMinutes } from "../../src/units/index.js";
import { MAX_SPAN_MS } from "../../src/units/working-time.js";
import { PurchaseQuestionDto, SpendingLimitAnswerDto } from "../flow/fixtures/questions.fixture.js";

class Interpreter {
  readonly fixture = true;
}

/** A question role with the options given, named `name`. */
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

const useOf = (channel: Class): ChannelUse => ({
  tool: "ask-tool",
  toolInput: PurchaseQuestionDto,
  channel,
  workflow: "w-workflow",
  isQuestion: true,
});

const found = (role: Class) =>
  channelRuleViolations([useOf(role)], [])
    .filter((one) => !one.code.startsWith("di.") && !one.code.includes("working-time"))
    .map(({ code, message, nodes }) => ({ code, message, nodes }));

const expiresMessage = (name: string, shown: string) =>
  `channel role ${name}: expiresIn is ${shown} — a deadline is a positive finite duration of at least seconds(1) and at most 5 years, like hours(24)`;

describe("#1366: the deadline of a role", () => {
  it("accepts a duration from seconds(1) to 5 years, plain or working", () => {
    for (const expiresIn of [
      seconds(1),
      hours(4),
      MAX_SPAN_MS,
      workingHours(2),
      workingMinutes(1),
    ]) {
      expect(found(roleWith("ok-channel", { expiresIn }))).toEqual([]);
    }
  });

  it("names one that is too short, too long or no finite number, by its text", () => {
    for (const [expiresIn, shown] of [
      [999, "999"],
      [0, "0"],
      [-5, "-5"],
      [MAX_SPAN_MS + 1, String(MAX_SPAN_MS + 1)],
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [workingMinutes(0.01), "600 ms of working time"],
    ] as const) {
      expect(found(roleWith("bad-channel", { expiresIn }))).toEqual([
        {
          code: "channel.expires-in-invalid",
          message: expiresMessage("bad-channel", shown),
          nodes: ["bad-channel"],
        },
      ]);
    }
  });

  it("reads isExpiresIn at its bounds, and no text or nothing", () => {
    expect(isExpiresIn(1000)).toBe(true);
    expect(isExpiresIn(999)).toBe(false);
    expect(isExpiresIn(MAX_SPAN_MS)).toBe(true);
    expect(isExpiresIn(MAX_SPAN_MS + 1)).toBe(false);
    expect(isExpiresIn("1000")).toBe(false);
    expect(isExpiresIn(undefined)).toBe(false);
  });
});

describe("#1366: the reminder of a role", () => {
  const remindMessage = (name: string, problem: string) => `channel role ${name}: ${problem}`;

  it("names a reminder that is no positive finite duration", () => {
    for (const [remindBefore, shown] of [
      [0, "0"],
      [-1, "-1"],
      [Number.NaN, "NaN"],
      [MAX_SPAN_MS + 1, String(MAX_SPAN_MS + 1)],
    ] as const) {
      expect(found(roleWith("remind-channel", { remindBefore, expiresIn: hours(4) }))).toEqual([
        {
          code: "channel.remind-before-invalid",
          message: remindMessage(
            "remind-channel",
            `remindBefore is ${shown} — a reminder is a positive finite duration of at most 5 years, like hours(2)`,
          ),
          nodes: ["remind-channel"],
        },
      ]);
    }
  });

  it("names a reminder not shorter than its deadline, plain and working", () => {
    expect(
      found(roleWith("late-channel", { remindBefore: hours(4), expiresIn: hours(4) })),
    ).toEqual([
      {
        code: "channel.remind-before-invalid",
        message: remindMessage(
          "late-channel",
          "remindBefore (14400000 ms) is not shorter than its expiresIn (14400000 ms) — the reminder would go out at or before the pause is asked",
        ),
        nodes: ["late-channel"],
      },
    ]);
    expect(
      found(
        roleWith("late-channel", { remindBefore: workingHours(5), expiresIn: workingHours(4) }),
      ).map((one) => one.message),
    ).toEqual([
      remindMessage(
        "late-channel",
        "remindBefore (18000000 ms of working time) is not shorter than its expiresIn (14400000 ms of working time) — the reminder would go out at or before the pause is asked",
      ),
    ]);
  });

  it("accepts a shorter reminder, a reminder beside no deadline, and a tiny one", () => {
    expect(found(roleWith("ok-channel", { remindBefore: hours(1), expiresIn: hours(4) }))).toEqual(
      [],
    );
    expect(
      found(roleWith("ok-channel", { remindBefore: workingHours(1), expiresIn: workingHours(4) })),
    ).toEqual([]);
    expect(found(roleWith("ok-channel", { remindBefore: hours(1) }))).toEqual([]);
    expect(found(roleWith("ok-channel", { remindBefore: 0.001, expiresIn: hours(4) }))).toEqual([]);
  });

  it("compares a reminder with a deadline only of its own kind", () => {
    expect(isNotShorter(hours(1), workingHours(1))).toBe(false);
    expect(isNotShorter(workingHours(1), hours(1))).toBe(false);
    expect(isNotShorter(hours(1), hours(1))).toBe(true);
    expect(isNotShorter(hours(2), hours(1))).toBe(true);
    expect(isNotShorter(hours(1), hours(2))).toBe(false);
    expect(isNotShorter(hours(1), "x")).toBe(false);
    expect(isNotShorter(hours(1), undefined)).toBe(false);
    expect(isNotShorter(hours(1), "1000")).toBe(false);
  });

  it("#1310b: working days compare with working days only: a day count is no hour count", () => {
    expect(isNotShorter(workDays(2), workDays(2))).toBe(true);
    expect(isNotShorter(workDays(3), workDays(2))).toBe(true);
    expect(isNotShorter(workDays(1), workDays(2))).toBe(false);
    // the calendar's schedule says how long a day is: not comparable here
    expect(isNotShorter(workDays(1), workingHours(8))).toBe(false);
    expect(isNotShorter(workingHours(100), workDays(1))).toBe(false);
  });

  it("reads isRemindBefore from the smallest positive number to 5 years", () => {
    expect(isRemindBefore(Number.MIN_VALUE)).toBe(true);
    expect(isRemindBefore(0)).toBe(false);
    expect(isRemindBefore(MAX_SPAN_MS)).toBe(true);
    expect(isRemindBefore(MAX_SPAN_MS + 1)).toBe(false);
    expect(isRemindBefore(workingMinutes(5))).toBe(true);
  });
});

describe("#1366: the visits of a question role", () => {
  it("names a maxVisits that is no whole number from 0, by its kind", () => {
    for (const [maxVisits, shown] of [
      [-1, "-1"],
      [1.5, "1.5"],
      ["3", "a string"],
      [null, "null"],
    ] as const) {
      expect(found(roleWith("visits-channel", { maxVisits }))).toEqual([
        {
          code: "limits.count-invalid",
          message: `channel role visits-channel: maxVisits is ${shown}, not a whole number from 0 — maxVisits: 3 sets it; leave it out for no limit`,
          nodes: ["visits-channel"],
        },
      ]);
    }
    expect(found(roleWith("visits-channel", { maxVisits: 0 }))).toEqual([]);
    const approval = (maxVisits: unknown): Class => {
      @ChannelRole({
        name: "approving-channel",
        description: "d",
        approves: PurchaseQuestionDto,
        answerer: PauseAnswerer.Channel,
        maxVisits,
      } as never)
      abstract class Approving extends ChannelOf<Approving> {}
      return Approving;
    };

    expect(found(approval(-1))).toEqual([]);
    expect(found(roleWith("visits-channel", { maxVisits: undefined }))).toEqual([]);
  });
});

describe("#1366: the implementation of a role", () => {
  class Base {
    readonly fixture = true;
  }
  class First extends Base {}
  class Second extends Base {}
  class Unrelated {
    readonly fixture = true;
  }

  it("lists the classes that extend the role, once each, and not the role itself or another class", () => {
    const modules = [
      { providers: [First, Base, Unrelated, { provide: "token", useValue: 1 }] },
      { providers: [Second, First] },
    ];

    expect(implementationsOf(Base, modules as never)).toEqual([First, Second]);
    expect(implementationsOf(Base, [])).toEqual([]);
  });

  it("takes a provider for an implementation only when it is a class", () => {
    const lookalike = { prototype: First.prototype };

    expect(implementationsOf(Base, [{ providers: [lookalike, Base] }] as never)).toEqual([]);
  });

  it("names anonymous implementations by their kind of class", () => {
    const role = roleWith("anon-channel");
    const impls = [
      class extends (role as new () => object) {},
      class extends (role as new () => object) {},
    ];

    expect(
      channelRuleViolations([useOf(role)], [{ providers: impls }] as never).map(
        (one) => one.message,
      ),
    ).toEqual([
      "channel role SomeQuestion (anon-channel) has 2 implementations: (anonymous class), (anonymous class) — list one (one question to several places is one implementation that sends to each)",
    ]);
  });

  it("names a role with none, and a role with several, by its name", () => {
    const role = roleWith("lonely-channel");
    const uses = [useOf(role)];

    expect(
      channelRuleViolations(uses, []).map(({ code, message, nodes }) => ({ code, message, nodes })),
    ).toEqual([
      {
        code: "di.missing-implementation",
        message:
          "channel role SomeQuestion (lonely-channel) has no implementation — list a @Channel class that extends SomeQuestion in @Application({ providers })",
        nodes: ["lonely-channel"],
      },
    ]);
    class OneImpl extends (role as new () => object) {}
    class TwoImpl extends (role as new () => object) {}

    expect(
      channelRuleViolations(uses, [{ providers: [OneImpl, TwoImpl] }] as never).map(
        ({ code, message, nodes }) => ({ code, message, nodes }),
      ),
    ).toEqual([
      {
        code: "di.ambiguous-implementation",
        message:
          "channel role SomeQuestion (lonely-channel) has 2 implementations: OneImpl, TwoImpl — list one (one question to several places is one implementation that sends to each)",
        nodes: ["lonely-channel"],
      },
    ]);
    expect(channelRuleViolations(uses, [{ providers: [OneImpl] }] as never)).toEqual([]);
  });
});

describe("#1366: a reply interpreter shared by two roles", () => {
  it("names the roles that share it, and not a role with its own or none", () => {
    const one = roleWith("one-channel", { replyInterpreter: Interpreter });
    const two = roleWith("two-channel", { replyInterpreter: Interpreter });
    const own = roleWith("own-channel", {
      replyInterpreter: class Mine {
        readonly fixture = true;
      },
    });
    const none = roleWith("none-channel");

    expect(
      sharedInterpreterViolations([useOf(one), useOf(two), useOf(own), useOf(none)]).map(
        ({ code, message, nodes }) => ({ code, message, nodes }),
      ),
    ).toEqual([
      {
        code: "channel.shared-interpreter",
        message:
          "reply interpreter Interpreter is used by one-channel and two-channel — an interpreter belongs to one role; give each role its own",
        nodes: ["one-channel", "two-channel"],
      },
    ]);
    expect(sharedInterpreterViolations([useOf(one), useOf(own), useOf(none)])).toEqual([]);
    expect(sharedInterpreterViolations([])).toEqual([]);
  });
});
