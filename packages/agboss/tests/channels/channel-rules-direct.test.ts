/**
 * #1366, #1307: the assembly rules of pause targets on a timeout, a reminder, a calendar and a visit
 * count, called directly with the targets a workflow names: each violation's code, exact message and
 * nodes, the bounds of a duration (plain and working time), and a channel interpreter shared by two
 * targets. The shard `assembly-rules` mutates `channel-rules.ts` and `pause-timing-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import {
  channelRuleViolations,
  channelsOf,
  isNotShorter,
  isPauseTimeout,
  isRemindBefore,
  sharedInterpreterViolations,
} from "../../src/channels/channel-rules.js";
import type { ChannelUse } from "../../src/channels/discovery.js";
import { ExternalTask, ToolApproval } from "../../src/channels/pause-targets.js";
import { Channel } from "../../src/components/decorators.js";
import { ComponentOptions } from "../../src/components/component-options.js";
import type { Class } from "../../src/components/injection.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import {
  days,
  hours,
  seconds,
  workDays,
  workingHours,
  workingMinutes,
} from "../../src/units/index.js";
import { MAX_SPAN_MS } from "../../src/units/working-time.js";
import { PurchaseQuestionDto, SpendingLimitAnswerDto } from "../flow/fixtures/questions.fixture.js";

class Interpreter {
  readonly fixture = true;
}

/** What an untyped (JS) caller may pass: the compiler rules these forms out already. */
const untypedTask = ExternalTask as (options: object) => (cls: Class) => Class;
const untypedApproval = ToolApproval as (options: object) => (cls: Class) => Class;

/** An external task named `name` with the options given over a valid base. */
function taskWith(name: string, extra: Record<string, unknown> = {}): Class {
  class SomeExternalTask {
    readonly mark = "task";
  }
  return untypedTask({
    name,
    description: "d",
    input: PurchaseQuestionDto,
    output: SpendingLimitAnswerDto,
    respondent: PauseRespondent.Owner,
    timeout: days(1),
    ...extra,
  })(SomeExternalTask);
}

const useOf = (target: Class): ChannelUse => ({
  tool: "ask-tool",
  toolInput: PurchaseQuestionDto,
  target,
  workflow: "w-workflow",
  isQuestion: true,
});

const found = (target: Class) =>
  channelRuleViolations([useOf(target)], [], ComponentOptions.none).map(
    ({ code, message, nodes }) => ({ code, message, nodes }),
  );

const timeoutMessage = (name: string, shown: string) =>
  `pause target ${name}: timeout is ${shown} — a deadline is a positive finite duration of at least seconds(1) and at most 5 years, like hours(24)`;

describe("#1366: the timeout of a target", () => {
  it("accepts a duration from seconds(1) to 5 years, plain or working (with a calendar)", () => {
    for (const timeout of [seconds(1), hours(4), MAX_SPAN_MS]) {
      expect(found(taskWith("ok-external-task", { timeout }))).toEqual([]);
    }
  });

  it("names one that is too short, too long or no finite number, by its text", () => {
    for (const [timeout, shown] of [
      [999, "999"],
      [0, "0"],
      [-5, "-5"],
      [MAX_SPAN_MS + 1, String(MAX_SPAN_MS + 1)],
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
    ] as const) {
      expect(found(taskWith("bad-external-task", { timeout }))).toEqual([
        {
          code: "limits.timeout-invalid",
          message: timeoutMessage("bad-external-task", shown),
          nodes: ["bad-external-task"],
        },
      ]);
    }
  });

  it("reads isPauseTimeout at its bounds, and no text or nothing", () => {
    expect(isPauseTimeout(1000)).toBe(true);
    expect(isPauseTimeout(999)).toBe(false);
    expect(isPauseTimeout(MAX_SPAN_MS)).toBe(true);
    expect(isPauseTimeout(MAX_SPAN_MS + 1)).toBe(false);
    expect(isPauseTimeout("1000")).toBe(false);
    expect(isPauseTimeout(undefined)).toBe(false);
  });
});

describe("#1366: the reminder of a target", () => {
  it("names a reminder that is no positive finite duration", () => {
    for (const [remindBefore, shown] of [
      [0, "0"],
      [-1, "-1"],
      [Number.NaN, "NaN"],
    ] as const) {
      expect(found(taskWith("remind-external-task", { remindBefore }))).toEqual([
        {
          code: "pause.remind-before-invalid",
          message: `pause target remind-external-task: remindBefore is ${shown} — a reminder is a positive finite duration of at most 5 years, like hours(2)`,
          nodes: ["remind-external-task"],
        },
      ]);
    }
  });

  it("names a reminder not shorter than its timeout", () => {
    expect(
      found(taskWith("late-external-task", { timeout: hours(1), remindBefore: hours(1) })),
    ).toEqual([
      {
        code: "pause.remind-before-invalid",
        message:
          "pause target late-external-task: remindBefore (3600000 ms) is not shorter than its timeout (3600000 ms) — the reminder would go out at or before the pause is asked",
        nodes: ["late-external-task"],
      },
    ]);
  });

  it("accepts a shorter reminder, and a reminder beside a hook that may tighten the timeout", () => {
    expect(
      found(taskWith("early-external-task", { timeout: hours(4), remindBefore: hours(1) })),
    ).toEqual([]);
    expect(isNotShorter(hours(1), hours(4))).toBe(false);
    expect(isNotShorter(hours(4), hours(4))).toBe(true);
    expect(isRemindBefore(1)).toBe(true);
    expect(isRemindBefore(0)).toBe(false);
  });

  it("refuses a working reminder before a plain timeout: a calendar cannot subtract", () => {
    expect(
      found(
        taskWith("mixed-external-task", { timeout: hours(4), remindBefore: workingHours(1) }),
      ).map((one) => one.code),
    ).toContain("pause.remind-before-working-without-working-timeout");
  });
});

describe("#1310: working time needs the target's calendar", () => {
  it("a working timeout or reminder with no calendar is [calendar.required-for-working-duration]", () => {
    expect(found(taskWith("work-external-task", { timeout: workingHours(8) }))).toEqual([
      {
        code: "calendar.required-for-working-duration",
        message:
          "pause target work-external-task: working time needs a calendar — set calendar on it (a @WorkingCalendar class), or use plain durations (min, hours, days)",
        nodes: ["work-external-task"],
      },
    ]);
    expect(
      found(taskWith("days-external-task", { timeout: workDays(2) })).map((one) => one.code),
    ).toEqual(["calendar.required-for-working-duration"]);
    expect(
      found(taskWith("minutes-external-task", { timeout: workingMinutes(30) })).map(
        (one) => one.code,
      ),
    ).toEqual(["calendar.required-for-working-duration"]);
  });
});

describe("#1366: the visits of an external task", () => {
  it("names a maxVisits that is no whole number from 0, by its kind", () => {
    for (const [maxVisits, shown] of [
      [-1, "-1"],
      [1.5, "1.5"],
      ["3", "a string"],
      [null, "null"],
    ] as const) {
      expect(found(taskWith("visits-external-task", { maxVisits }))).toEqual([
        {
          code: "limits.count-invalid",
          message: `external task visits-external-task: maxVisits is ${shown}, not a whole number from 0 — maxVisits: 3 sets it; leave it out for no limit`,
          nodes: ["visits-external-task"],
        },
      ]);
    }
    expect(found(taskWith("visits-external-task", { maxVisits: 0 }))).toEqual([]);
    expect(found(taskWith("visits-external-task", { maxVisits: undefined }))).toEqual([]);
  });

  it("a tool approval has no visits to count", () => {
    class Approving {
      readonly mark = "approving";
    }
    const approval = untypedApproval({
      name: "approving-tool-approval",
      description: "d",
      input: PurchaseQuestionDto,
      respondent: PauseRespondent.Delegate,
      timeout: days(1),
      maxVisits: -1,
    })(Approving);

    expect(
      channelRuleViolations(
        [{ ...useOf(approval), isQuestion: undefined }],
        [],
        ComponentOptions.none,
      )
        .map((one) => one.code)
        .filter((code) => code === "limits.count-invalid"),
    ).toEqual([]);
  });
});

describe("#1307: the channels of a target", () => {
  it("lists the listed @Channel classes that name it as their target, once each", () => {
    const target = taskWith("served-external-task");
    class First {
      send(): void {
        return undefined;
      }
    }
    class Second {
      send(): void {
        return undefined;
      }
    }
    const served = (cls: Class): Class =>
      Channel({ name: `${cls.name.toLowerCase()}-channel`, target, ttl: days(1) })(cls as never);
    const [first, second] = [served(First), served(Second)];
    class Other {
      readonly mark = "other";
    }

    expect(channelsOf(target, [{ providers: [first, Other, second, first] }] as never)).toEqual([
      first,
      second,
    ]);
    expect(channelsOf(target, [])).toEqual([]);
  });
});

describe("#1366: a channel interpreter shared by two targets", () => {
  it("names the targets that share it, and not a target with its own or none", () => {
    const one = taskWith("one-external-task", { channelInterpreter: Interpreter });
    const two = taskWith("two-external-task", { channelInterpreter: Interpreter });
    const own = taskWith("own-external-task", {
      channelInterpreter: class Mine {
        readonly fixture = true;
      },
    });
    const none = taskWith("none-external-task");

    expect(
      sharedInterpreterViolations([useOf(one), useOf(two), useOf(own), useOf(none)]).map(
        ({ code, message, nodes }) => ({ code, message, nodes }),
      ),
    ).toEqual([
      {
        code: "channel.shared-interpreter",
        message:
          "channel interpreter Interpreter is used by one-external-task and two-external-task — an interpreter belongs to one target; give each target its own",
        nodes: ["one-external-task", "two-external-task"],
      },
    ]);
    expect(sharedInterpreterViolations([useOf(one), useOf(own), useOf(none)])).toEqual([]);
    expect(sharedInterpreterViolations([])).toEqual([]);
  });
});
