/**
 * #941 AC1 / AC2, at compile time: `PauseExpiration.decide` takes the role's answer type;
 * `PauseExpiryHandler<Role>` is sync or async; an expiry decision is `fail()` or `decide(answer)`.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  PauseExpiration,
  PauseExpirationKind,
  type ChannelAsk,
  type ChannelRoleBaseOptions,
  type DecideExpiration,
  type FailExpiration,
  type ReassignExpiration,
  type PauseExpiryHandler,
  type QuestionStepOptions,
  type ToolOptions,
} from "../../src/index.js";
import type { DtoClass } from "../../src/dto/types.js";
import { hours, type Milliseconds, type WorkingDuration } from "../../src/units/index.js";
import { ManagerQuestion } from "../flow/fixtures/expiry.fixture.js";

describe("#941: PauseExpiration and PauseExpiryHandler", () => {
  it("fail() and decide(answer) are the two kinds", () => {
    expectTypeOf(PauseExpiration.fail()).toEqualTypeOf<FailExpiration>();
    expectTypeOf(PauseExpiration.fail().kind).toEqualTypeOf<PauseExpirationKind.Fail>();
    expectTypeOf(PauseExpiration.decide({ approved: true })).toEqualTypeOf<
      DecideExpiration<{ approved: boolean }>
    >();
    expectTypeOf(PauseExpiration.decide(1).kind).toEqualTypeOf<PauseExpirationKind.Decide>();
  });

  it("a handler of a role returns the role's expiration: decide checks the role's answer type", () => {
    class Sync implements PauseExpiryHandler<ManagerQuestion> {
      onPauseExpired(ask: ChannelAsk<ManagerQuestion>) {
        expectTypeOf(ask.input.orderId).toEqualTypeOf<string>();
        return ask.input.orderId === "small"
          ? PauseExpiration.decide({ approved: true, comment: "auto" })
          : PauseExpiration.fail();
      }
    }
    class Async implements PauseExpiryHandler<ManagerQuestion> {
      onPauseExpired(): Promise<PauseExpiration<ManagerQuestion>> {
        return Promise.resolve(PauseExpiration.decide({ approved: false }));
      }
    }
    class Wrong implements PauseExpiryHandler<ManagerQuestion> {
      // @ts-expect-error the answer must be the role's: { approved: boolean, comment?: string }
      onPauseExpired() {
        return PauseExpiration.decide({ approved: "yes" });
      }
    }

    expectTypeOf<Sync["onPauseExpired"]>().toBeFunction();
    expectTypeOf<Async["onPauseExpired"]>().toBeFunction();
    expectTypeOf<Wrong["onPauseExpired"]>().toBeFunction();
  });

  it("a role, a tool and a question step take an expiresIn: a duration", () => {
    expectTypeOf<ChannelRoleBaseOptions["expiresIn"]>().toEqualTypeOf<
      Milliseconds | WorkingDuration | undefined
    >();
    expectTypeOf<ToolOptions<DtoClass, DtoClass, []>["expiresIn"]>().toEqualTypeOf<
      Milliseconds | WorkingDuration | undefined
    >();
    expectTypeOf<QuestionStepOptions["expiresIn"]>().toEqualTypeOf<
      Milliseconds | WorkingDuration | undefined
    >();
    const options: QuestionStepOptions = { expiresIn: hours(4) };
    // @ts-expect-error a duration (hours(4)), not a number
    const bad: QuestionStepOptions = { expiresIn: 4 };
    expectTypeOf(options).toExtend<QuestionStepOptions>();
    expectTypeOf(bad).toExtend<QuestionStepOptions>();
  });

  it("#1310a: reassign takes assignees, a duration and a reason — and nothing of a person's answer", () => {
    const moved = PauseExpiration.reassign({
      assignees: ["deputy-1"],
      timeout: hours(2),
      reason: "no answer",
    });
    expectTypeOf(moved).toEqualTypeOf<ReassignExpiration>();
    expectTypeOf(moved.kind).toEqualTypeOf<PauseExpirationKind.Reassign>();
    // @ts-expect-error assignees are required
    PauseExpiration.reassign({ timeout: hours(2) });
    // @ts-expect-error a duration (hours(2)), not a number
    PauseExpiration.reassign({ assignees: ["d"], timeout: 2 });
  });
});
