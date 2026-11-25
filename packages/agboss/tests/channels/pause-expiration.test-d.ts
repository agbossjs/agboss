/**
 * #941 AC1 / AC2, at compile time: `PauseExpiration.decide` takes the role's answer type;
 * `PauseExpiryHandler<Role>` is sync or async; an expiry decision is `fail()` or `decide(answer)`.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  PauseExpiration,
  PauseExpirationKind,
  type ExpiredContext,
  type ExternalTaskOptions,
  type ToolApprovalOptions,
  type DecideExpiration,
  type FailExpiration,
  type ReassignExpiration,
  type PauseExpiryHandler,
  type ChannelHandler,
  type ToolOptions,
} from "../../src/index.js";
import type { DtoClass } from "../../src/dto/types.js";
import { hours, type Milliseconds, type WorkingDuration } from "../../src/units/index.js";
import { ManagerExternalTask } from "../flow/fixtures/expiry.fixture.js";

describe("#941: PauseExpiration and PauseExpiryHandler", () => {
  it("fail() and decide(answer) are the two kinds", () => {
    expectTypeOf(PauseExpiration.fail()).toEqualTypeOf<FailExpiration>();
    expectTypeOf(PauseExpiration.fail().kind).toEqualTypeOf<PauseExpirationKind.Fail>();
    expectTypeOf(PauseExpiration.decide({ approved: true })).toEqualTypeOf<
      DecideExpiration<{ approved: boolean }>
    >();
    expectTypeOf(PauseExpiration.decide(1).kind).toEqualTypeOf<PauseExpirationKind.Decide>();
  });

  it("a target's onExpired returns its expiration: decide checks the target's output type", () => {
    class Sync implements PauseExpiryHandler<ManagerExternalTask> {
      onExpired(ctx: ExpiredContext<ManagerExternalTask>) {
        expectTypeOf(ctx.input.orderId).toEqualTypeOf<string>();
        expectTypeOf(ctx.expiresAt).toEqualTypeOf<Date>();
        expectTypeOf(ctx.firstAskedAt).toEqualTypeOf<Date>();
        return ctx.input.orderId === "small"
          ? PauseExpiration.decide({ approved: true, comment: "auto" })
          : PauseExpiration.fail();
      }
    }
    class Async implements PauseExpiryHandler<ManagerExternalTask> {
      onExpired(): Promise<PauseExpiration<ManagerExternalTask>> {
        return Promise.resolve(PauseExpiration.decide({ approved: false }));
      }
    }
    class Wrong implements PauseExpiryHandler<ManagerExternalTask> {
      // @ts-expect-error the answer must be the target's: { approved: boolean, comment?: string }
      onExpired() {
        return PauseExpiration.decide({ approved: "yes" });
      }
    }

    expectTypeOf<Sync["onExpired"]>().toBeFunction();
    expectTypeOf<Async["onExpired"]>().toBeFunction();
    expectTypeOf<Wrong["onExpired"]>().toBeFunction();
  });

  it("the channel no longer decides an expiry: onPauseExpired is gone from its contract", () => {
    // @ts-expect-error the expiry is the target's call (onExpired), no longer the channel's
    expectTypeOf<ChannelHandler<ManagerExternalTask>["onPauseExpired"]>().toBeUndefined();
  });

  it("a target takes a timeout: a duration; a tool and a step take none (#1307)", () => {
    expectTypeOf<ToolApprovalOptions["timeout"]>().toEqualTypeOf<Milliseconds | WorkingDuration>();
    expectTypeOf<ExternalTaskOptions["timeout"]>().toEqualTypeOf<Milliseconds | WorkingDuration>();
    // @ts-expect-error a tool has no deadline of its own: its approval's timeout is the one
    expectTypeOf<ToolOptions<DtoClass, DtoClass, []>["expiresIn"]>().toBeUndefined();
  });

  it("#1310a: reassign takes assignees, a target, a channel, a duration and a reason — and nothing of a person's answer", () => {
    const moved = PauseExpiration.reassign({
      target: ManagerExternalTask,
      assignees: ["deputy-1"],
      timeout: hours(2),
      reason: "no answer",
    });
    expectTypeOf(moved).toEqualTypeOf<ReassignExpiration>();
    expectTypeOf(moved.kind).toEqualTypeOf<PauseExpirationKind.Reassign>();
    // @ts-expect-error a target is a class, not its name
    PauseExpiration.reassign({ target: "manager-external-task" });
    // @ts-expect-error a duration (hours(2)), not a number
    PauseExpiration.reassign({ assignees: ["d"], timeout: 2 });
  });
});
