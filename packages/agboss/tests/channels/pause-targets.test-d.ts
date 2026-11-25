/**
 * #1307a / #1310c: the types of the pause targets — `PauseInputOf` / `PauseOutputOf` from the
 * generated `PauseTargets`, the hook contexts, `@Channel({ target })` needing a `ttl`, a hook that
 * returns the wrong thing refused on the decorator line, `ChannelInterpretation.notUnderstood(reason)`.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  Channel,
  ChannelInterpretation,
  ChannelListener,
  ExternalTask,
  PauseRespondent,
  ToolApproval,
  type ApprovalDecision,
  type AssignContext,
  type ChannelInterpreterHandler,
  type ChannelListenerHandler,
  type NotUnderstoodChannelInterpretation,
  type PauseInputOf,
  type PauseOutputOf,
  type UnderstoodChannelInterpretation,
} from "../../src/index.js";
import { days, hours } from "../../src/units/index.js";
import {
  PtLimitAnswerDto,
  PtLimitAskDto,
  PtLimitExternalTask,
  PtPayoutDto,
  PtPayoutToolApproval,
  PtAnyToolApproval,
} from "../flow/fixtures/pause-targets.fixture.js";

describe("#1307a: PauseInputOf / PauseOutputOf read the generated PauseTargets", () => {
  it("an approval's input is its gated tools' input; its output the decision of it", () => {
    expectTypeOf<PauseInputOf<PtPayoutToolApproval>>().toEqualTypeOf<PtPayoutDto>();
    expectTypeOf<PauseOutputOf<PtPayoutToolApproval>>().toEqualTypeOf<{
      readonly approved: boolean;
      readonly reason?: string;
      readonly overrideInput?: PtPayoutDto;
    }>();
    expectTypeOf<PauseOutputOf<PtPayoutToolApproval>>().toExtend<ApprovalDecision<PtPayoutDto>>();
  });

  it("an approval with no input has the union of the inputs of the tools it gates", () => {
    expectTypeOf<PauseInputOf<PtAnyToolApproval>>().toEqualTypeOf<PtLimitAskDto>();
  });

  it("an external task's input and output are its DTOs", () => {
    expectTypeOf<PauseInputOf<PtLimitExternalTask>>().toEqualTypeOf<PtLimitAskDto>();
    expectTypeOf<PauseOutputOf<PtLimitExternalTask>>().toEqualTypeOf<PtLimitAnswerDto>();
  });

  it("never in, never out", () => {
    expectTypeOf<PauseInputOf<never>>().toBeNever();
    expectTypeOf<PauseOutputOf<never>>().toBeNever();
  });

  it("a hook's context is typed by its target", () => {
    expectTypeOf<AssignContext<PtPayoutToolApproval>["input"]>().toEqualTypeOf<PtPayoutDto>();
  });
});

describe("#1307a: the decorators refuse what the types rule out", () => {
  it("a hook that returns the wrong thing is refused on the decorator line", () => {
    class BadAssign {
      assign(): number {
        return 1;
      }
    }
    const decorate = ToolApproval({
      name: "bad-tool-approval",
      description: "d",
      respondent: PauseRespondent.Owner,
      timeout: hours(1),
    });
    // @ts-expect-error assign returns readonly string[] | undefined
    decorate(BadAssign);
  });

  it("a target has a respondent and a timeout", () => {
    // @ts-expect-error respondent is required
    ToolApproval({ name: "a-tool-approval", description: "d", timeout: hours(1) });
    // @ts-expect-error timeout is required
    ExternalTask({
      name: "a-external-task",
      description: "d",
      input: PtLimitAskDto,
      output: PtLimitAnswerDto,
      respondent: PauseRespondent.Owner,
    });
  });

  it("a channel bound to a target needs its ttl", () => {
    // @ts-expect-error ttl is required with target
    Channel({ name: "a-channel", target: PtPayoutToolApproval });
    Channel({ name: "b-channel", target: PtPayoutToolApproval, ttl: days(1) });
  });
});

describe("#1310c: the interpretation and the listener", () => {
  it("understood carries the output, notUnderstood the reason as a plain string", () => {
    expectTypeOf(ChannelInterpretation.understood({ limitUsd: 1 })).toEqualTypeOf<
      UnderstoodChannelInterpretation<{ limitUsd: number }>
    >();
    expectTypeOf(
      ChannelInterpretation.notUnderstood("empty"),
    ).toEqualTypeOf<NotUnderstoodChannelInterpretation>();
    expectTypeOf<UnderstoodChannelInterpretation<number>>().toExtend<
      UnderstoodChannelInterpretation<unknown>
    >();
  });

  it("an interpreter's handler type is the interpret method of its target's types", () => {
    expectTypeOf<ChannelInterpreterHandler<never>>().not.toBeAny();
  });

  it("every hook of a listener is optional; a class of none is still a listener", () => {
    expectTypeOf<ChannelListenerHandler>().toEqualTypeOf<ChannelListenerHandler>();
    class Nothing {
      readonly nothing = true;
    }
    ChannelListener()(Nothing);
    class Expiring {
      onPauseExpiring(): void {
        this.seen = true;
      }
      seen = false;
    }
    ChannelListener({ name: "expiring-listener", includePauseIds: true })(Expiring);
    class WrongHook {
      onPauseOpened(): number {
        return 1;
      }
    }
    // @ts-expect-error a hook returns void or a promise of it
    ChannelListener()(WrongHook);
  });
});
