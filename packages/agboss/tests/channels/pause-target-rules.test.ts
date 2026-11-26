/**
 * #1307a / #1310c: the assembly rules of the pause targets, called directly with the targets a
 * workflow names — each violation's code, message and nodes — and the rules of `@ChannelListener`.
 * The shard `assembly-rules` mutates `pause-target-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import {
  Channel,
  ChannelInterpreter,
  ChannelListener,
  ChannelSelector,
  ExternalTask,
  PauseRespondent,
  ToolApproval,
  Tool,
} from "../../src/index.js";
import { channelRuleViolations } from "../../src/channels/channel-rules.js";
import type { ChannelUse } from "../../src/channels/discovery.js";
import { channelListenerRuleViolations } from "../../src/pause/channel-listener.js";
import type { Class } from "../../src/components/injection.js";
import { Text } from "../../src/dto/index.js";
import { days, hours, seconds } from "../../src/units/index.js";
import { PurchaseQuestionDto, SpendingLimitAnswerDto } from "../flow/fixtures/questions.fixture.js";
import { ComponentOptions } from "../../src/components/component-options.js";

class InputDto {
  @Text()
  value!: string;
}

class OutputDto {
  @Text()
  value!: string;
}

const useOf = (target: Class, isQuestion = false): ChannelUse => ({
  tool: "a-tool",
  toolInput: InputDto,
  target,
  workflow: "w-workflow",
  ...(isQuestion ? { isQuestion: true as const } : {}),
});

function approval(name: string, extra: Record<string, unknown> = {}): Class {
  @ToolApproval({
    name,
    description: "d",
    input: InputDto,
    respondent: PauseRespondent.Delegate,
    timeout: hours(1),
    ...extra,
  })
  class SomeToolApproval {}
  return SomeToolApproval;
}

function task(name: string, extra: Record<string, unknown> = {}): Class {
  @ExternalTask({
    name,
    description: "d",
    input: PurchaseQuestionDto,
    output: SpendingLimitAnswerDto,
    respondent: PauseRespondent.Owner,
    timeout: hours(1),
    ...extra,
  })
  class SomeTask {}
  return SomeTask;
}

function channelOf(target: Class, name: string, ttl = days(1)): Class {
  @Channel({ name, target, ttl })
  class SomeChannel {
    send() {
      return undefined;
    }
  }
  return SomeChannel;
}

const modulesOf = (...providers: Class[]) => [{ owner: "x-application", providers }];

const found = (uses: ChannelUse[], providers: Class[]) =>
  channelRuleViolations(uses, modulesOf(...providers), ComponentOptions.none).map(
    ({ code, message, nodes }) => ({
      code,
      message,
      nodes,
    }),
  );

describe("#1307a: a target has a channel", () => {
  it("a target with its channel is clean", () => {
    const target = approval("legal-tool-approval");
    expect(found([useOf(target)], [channelOf(target, "jira-channel")])).toEqual([]);
  });

  it("[channel.missing-for-target]: none lists a channel for it", () => {
    const target = approval("legal-tool-approval");
    expect(found([useOf(target)], [])).toEqual([
      {
        code: "channel.missing-for-target",
        message:
          "SomeToolApproval (legal-tool-approval) has no channel — list a @Channel({ target: SomeToolApproval }) class in @Application({ channels })",
        nodes: ["legal-tool-approval"],
      },
    ]);
  });

  it("an owner's target needs no channel (#1307c): it asks nobody", () => {
    const target = task("owner-external-task");
    expect(found([useOf(target, true)], [])).toEqual([]);
  });

  it("an owner's target with two channels and no selector is still ambiguous", () => {
    const target = task("owner-external-task");
    const providers = [channelOf(target, "one-channel"), channelOf(target, "two-channel")];
    expect(found([useOf(target, true)], providers).map(({ code }) => code)).toEqual([
      "channel.ambiguous-for-target",
    ]);
  });

  it("a delegate's target with no channel stays refused (#1307c)", () => {
    const target = approval("delegate-tool-approval");
    expect(found([useOf(target)], []).map(({ code }) => code)).toEqual([
      "channel.missing-for-target",
    ]);
  });

  it("[channel.ambiguous-for-target]: two channels and no selector", () => {
    const target = approval("legal-tool-approval");
    const one = channelOf(target, "one-channel");
    const two = channelOf(target, "two-channel");
    expect(found([useOf(target)], [one, two])).toEqual([
      {
        code: "channel.ambiguous-for-target",
        message:
          "SomeToolApproval (legal-tool-approval) has 2 channels: SomeChannel, SomeChannel — add a @ChannelSelector({ target: SomeToolApproval }) that picks one, or list one",
        nodes: ["legal-tool-approval"],
      },
    ]);
  });

  it("a selector for the target answers the ambiguity", () => {
    const target = approval("legal-tool-approval");
    @ChannelSelector({ target })
    class Selector {
      selectChannel() {
        return channelOf(target, "x-channel");
      }
    }
    const providers = [
      channelOf(target, "one-channel"),
      channelOf(target, "two-channel"),
      Selector,
    ];
    // the selector answers the ambiguity
    expect(found([useOf(target)], providers)).toEqual([]);
  });

  it("a delegate's external task is checked like an approval", () => {
    const target = task("limit-external-task", { respondent: PauseRespondent.Delegate });
    expect(found([useOf(target, true)], []).map((one) => one.code)).toEqual([
      "channel.missing-for-target",
    ]);
  });
});

describe("#1307a: a channel and a selector name a target", () => {
  it("[channel.target-invalid]: the target is no pause target", () => {
    class Plain {
      readonly plain = true;
    }
    const providers = [channelOf(Plain, "stray-channel")];
    expect(found([], providers)).toEqual([
      {
        code: "channel.target-invalid",
        message:
          "channel stray-channel (SomeChannel) names Plain as its target, which is no @ToolApproval or @ExternalTask",
        nodes: ["stray-channel"],
      },
    ]);
  });

  it("[channel.ttl-invalid]: a ttl must be longer than the 30 s lease", () => {
    const target = approval("legal-tool-approval");
    for (const ttl of [seconds(30), seconds(1), Number.NaN]) {
      expect(found([], [channelOf(target, "short-channel", ttl as never)])).toEqual([
        {
          code: "channel.ttl-invalid",
          message:
            "channel short-channel (SomeChannel): ttl must be a finite duration longer than the execution lease (30 s) — days(14) keeps a closed pause two weeks",
          nodes: ["short-channel"],
        },
      ]);
    }
    expect(found([], [channelOf(target, "long-channel", seconds(31))])).toEqual([]);
  });

  it("[channel-selector.no-select-method] and [channel-selector.target-invalid]", () => {
    class Plain {
      readonly plain = true;
    }
    // @ts-expect-error a selector without selectChannel does not compile; a JS class gets the rule
    @ChannelSelector({ target: Plain })
    class Selector {}
    expect(found([], [Selector as never]).map((one) => one.code)).toEqual([
      "channel-selector.no-select-method",
      "channel-selector.target-invalid",
    ]);
  });
});

describe("#1307a: names and escalation", () => {
  it("[name.kind-suffix]: an approval's name ends with -tool-approval", () => {
    const target = approval("legal-approval");
    const codes = found([useOf(target)], [channelOf(target, "jira-channel")]);
    expect(codes).toEqual([
      {
        code: "name.kind-suffix",
        message: '"legal-approval" on @ToolApproval — name it "legal-approval-tool-approval"',
        nodes: ["legal-approval"],
      },
    ]);
  });

  it("[pause.incompatible-escalation-target]: another kind, another DTO, or no target at all", () => {
    const toTask = task("limit-external-task");
    const other = approval("other-tool-approval", { input: OutputDto });
    const same = approval("same-tool-approval");
    class Plain {
      readonly plain = true;
    }
    const from = approval("from-tool-approval", { escalatesTo: [toTask, other, same, Plain] });
    const providers = [channelOf(from, "from-channel")];
    const violations = found([useOf(from)], providers);
    expect(violations.map((one) => one.code)).toEqual(
      Array.from({ length: 3 }, () => "pause.incompatible-escalation-target"),
    );
    expect(violations.map((one) => one.message)).toEqual([
      "from-tool-approval escalates to SomeTask, which is of another kind or takes other DTOs — a pause can move only to a target of its kind with the same input (SomeToolApproval)",
      "from-tool-approval escalates to SomeToolApproval, which is of another kind or takes other DTOs — a pause can move only to a target of its kind with the same input (SomeToolApproval)",
      "from-tool-approval escalates to Plain, which is no @ToolApproval or @ExternalTask — a pause can move only to a target of its kind with the same input (SomeToolApproval)",
    ]);
  });

  it("an external task escalates only to a task of the same input and output", () => {
    const same = task("same-external-task");
    const other = task("other-external-task", { output: OutputDto });
    const from = task("from-external-task", { escalatesTo: [same, other] });
    expect(found([useOf(from, true)], [channelOf(from, "from-channel")]).length).toBe(1);
  });
});

describe("#1307a: @Tool names its approval", () => {
  it("a target with no respondent is refused when the decorator runs", () => {
    expect(() => approval("legal-tool-approval", { respondent: undefined })).toThrow(
      '[pause-target.respondent] @ToolApproval "legal-tool-approval" has no respondent',
    );
  });
});

describe("#1310c: the rules of @ChannelListener and @ChannelInterpreter", () => {
  const rules = (...providers: Class[]) =>
    channelListenerRuleViolations("x-application", providers).map(({ code, message }) => ({
      code,
      message,
    }));

  it("a listener of one hook is clean", () => {
    @ChannelListener()
    class Expiring {
      onPauseExpiring(): void {
        this.seen = true;
      }
      seen = false;
    }
    expect(rules(Expiring)).toEqual([]);
  });

  it("[channel-listener.missing-handler]: no hook at all", () => {
    @ChannelListener()
    class Empty {
      readonly empty = true;
    }
    expect(rules(Empty).map((one) => one.code)).toEqual(["channel-listener.missing-handler"]);
  });

  it("[channel-listener.unknown-hook]: a typo, and the old name of a hook", () => {
    @ChannelListener()
    class Typo {
      onPauseOpened(): void {
        this.seen = true;
      }
      seen = false;
      onPauseExpirng(): void {
        this.seen = true;
      }
      onPauseExtended(): void {
        this.seen = true;
      }
    }
    expect(rules(Typo).map((one) => one.code)).toEqual([
      "channel-listener.unknown-hook",
      "channel-listener.unknown-hook",
    ]);
  });

  it("the name defaults to the class name in kebab-case, two with one name clash", () => {
    @ChannelListener({ name: "same-listener" })
    class One {
      onPauseOpened(): void {
        this.seen = true;
      }
      seen = false;
    }
    @ChannelListener({ name: "same-listener" })
    class Two {
      onPauseOpened(): void {
        this.seen = true;
      }
      seen = false;
    }
    expect(rules(One, Two).map((one) => one.code)).toEqual(["channel-listener.duplicate-name"]);
  });

  it("a @ChannelInterpreter with neither interpret nor a model is [channel-interpreter.no-interpret-method]", async () => {
    @ChannelInterpreter()
    class Empty {
      readonly empty = true;
    }
    const target = approval("legal-tool-approval", { channelInterpreter: Empty });
    expect(
      found([useOf(target)], [channelOf(target, "jira-channel")]).map((one) => one.code),
    ).toEqual(["channel-interpreter.no-interpret-method"]);
  });

  it("an undecorated interpreter is [channel-interpreter.not-an-interpreter]", () => {
    class Undecorated {
      readonly undecorated = true;
    }
    const target = approval("legal-tool-approval", { channelInterpreter: Undecorated });
    expect(
      found([useOf(target)], [channelOf(target, "jira-channel")]).map((one) => one.code),
    ).toEqual(["channel-interpreter.not-an-interpreter"]);
  });
});

describe("#1307a: every permission hook of a target is called by the runtime", () => {
  it("permitAnswer is called by app.resume (#1307c): a target defining it is clean", () => {
    class Gated {
      permitAnswer() {
        return false;
      }
    }
    ToolApproval({
      name: "gated-tool-approval",
      description: "d",
      input: InputDto,
      respondent: PauseRespondent.Delegate,
      timeout: hours(1),
    })(Gated);
    expect(found([useOf(Gated)], [channelOf(Gated, "gated-channel")])).toEqual([]);
  });

  it.each(["permitTimeoutChange", "permitReassign"])(
    "%s is called by the runtime (app.setPauseTimeout, app.reassignPause): a target defining it is clean",
    (hook) => {
      class Gated {
        [key: string]: unknown;
      }
      Object.defineProperty(Gated.prototype, hook, { value: () => false });
      ToolApproval({
        name: "gated-tool-approval",
        description: "d",
        input: InputDto,
        respondent: PauseRespondent.Delegate,
        timeout: hours(1),
      })(Gated);
      expect(found([useOf(Gated)], [channelOf(Gated, "gated-channel")])).toEqual([]);
    },
  );

  it("a target without the hooks is clean", () => {
    const target = approval("plain-tool-approval");
    expect(found([useOf(target)], [channelOf(target, "plain-channel")])).toEqual([]);
  });
});

describe("#1307: every setting of a target is read at run time, so none is refused as ignored", () => {
  it.each(["assign", "resolveTimeout", "onExpired"])("the hook %s is clean", (hook) => {
    class Hooked {
      [key: string]: unknown;
    }
    Object.defineProperty(Hooked.prototype, hook, { value: () => undefined });
    ToolApproval({
      name: "hooked-tool-approval",
      description: "d",
      input: InputDto,
      respondent: PauseRespondent.Delegate,
      timeout: hours(1),
    })(Hooked);
    expect(found([useOf(Hooked)], [channelOf(Hooked, "hooked-channel")])).toEqual([]);
  });

  it("escalationLimits and a channel's call timeout are clean", () => {
    const target = approval("limited-tool-approval", {
      escalationLimits: { maxExtensions: 1, maxReassignments: 2 },
    });
    @Channel({ name: "slow-channel", target, ttl: days(1), timeout: seconds(5) })
    class Slow {
      send() {
        return undefined;
      }
    }
    expect(found([useOf(target)], [Slow])).toEqual([]);
  });

  it("an external task's escalationLimits are clean", () => {
    const target = task("limited-external-task", { escalationLimits: { maxExtensions: 1 } });
    expect(found([useOf(target, true)], [channelOf(target, "limited-channel")])).toEqual([]);
  });
});
