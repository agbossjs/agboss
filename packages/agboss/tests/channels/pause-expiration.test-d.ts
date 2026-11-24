/**
 * #941 AC1 / AC2, at compile time: `PauseExpiration.decide` takes the role's answer type;
 * `PauseExpiryHandler<Role>` is sync or async; an expiry decision is `fail()` or `decide(answer)`.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  PauseExpiration,
  PauseExpirationKind,
  type ChannelAsk,
  type ExternalTaskOptions,
  type ToolApprovalOptions,
  type DecideExpiration,
  type FailExpiration,
  type ReassignExpiration,
  type PauseExpiryHandler,
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

  it("a handler of a role returns the role's expiration: decide checks the role's answer type", () => {
    class Sync implements PauseExpiryHandler<ManagerExternalTask> {
      onPauseExpired(ask: ChannelAsk<ManagerExternalTask>) {
        expectTypeOf(ask.input.orderId).toEqualTypeOf<string>();
        return ask.input.orderId === "small"
          ? PauseExpiration.decide({ approved: true, comment: "auto" })
          : PauseExpiration.fail();
      }
    }
    class Async implements PauseExpiryHandler<ManagerExternalTask> {
      onPauseExpired(): Promise<PauseExpiration<ManagerExternalTask>> {
        return Promise.resolve(PauseExpiration.decide({ approved: false }));
      }
    }
    class Wrong implements PauseExpiryHandler<ManagerExternalTask> {
      // @ts-expect-error the answer must be the role's: { approved: boolean, comment?: string }
      onPauseExpired() {
        return PauseExpiration.decide({ approved: "yes" });
      }
    }

    expectTypeOf<Sync["onPauseExpired"]>().toBeFunction();
    expectTypeOf<Async["onPauseExpired"]>().toBeFunction();
    expectTypeOf<Wrong["onPauseExpired"]>().toBeFunction();
  });

  it("a target takes a timeout: a duration; a tool and a step take none (#1307)", () => {
    expectTypeOf<ToolApprovalOptions["timeout"]>().toEqualTypeOf<Milliseconds | WorkingDuration>();
    expectTypeOf<ExternalTaskOptions["timeout"]>().toEqualTypeOf<Milliseconds | WorkingDuration>();
    // @ts-expect-error a tool has no deadline of its own: its approval's timeout is the one
    expectTypeOf<ToolOptions<DtoClass, DtoClass, []>["expiresIn"]>().toBeUndefined();
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
