import { describe, expectTypeOf, it } from "vitest";
import type { ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import type * as Root from "../../../src/index.js";
import type { MissingGeneratedTypes } from "../../../src/flow/generated-types.js";
import { RefundCardInputDto, type RefundDeskToolApproval } from "../fixtures/refunds.fixture.js";
import { OfferDraftDto, ShortlistDto } from "../fixtures/dtos.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { ExternalTask, ToolApproval } from "../../../src/index.js";
import { hours } from "../../../src/units/index.js";

/**
 * #267 AC6 (PR 1): a tool approval's `input` types the ask's `input` and the decision's
 * `overrideInput` — through the generated `PauseTargets` table (`check:types`).
 */

describe("#267 AC6: approves types arguments", () => {
  it("ask.value.arguments is the role's approves DTO", () => {
    expectTypeOf<ChannelAsk<RefundDeskToolApproval>["input"]>().toEqualTypeOf<RefundCardInputDto>();
    expectTypeOf<ChannelAsk<RefundDeskToolApproval>["pauseId"]>().toEqualTypeOf<string>();
  });

  it("a decided outcome takes the role's decision, overrideInput typed by the same DTO", () => {
    const decided: ChannelOutcome<RefundDeskToolApproval> = ChannelOutcome.decided({
      approved: true,
      by: "rule",
      overrideInput: { orderId: "A-1", amountCents: 100 },
    });
    expectTypeOf(decided).not.toBeNever();
    // @ts-expect-error — overrideInput must be a RefundCardInputDto (amountCents missing)
    const wrong: ChannelOutcome<RefundDeskToolApproval> = ChannelOutcome.decided({
      approved: true,
      by: "rule",
      overrideInput: { orderId: "A-1" },
    });
    expectTypeOf(wrong).not.toBeNever();
    // @ts-expect-error — the decision needs approved and by
    const empty: ChannelOutcome<RefundDeskToolApproval> = ChannelOutcome.decided({});
    expectTypeOf(empty).not.toBeNever();
  });

  it("awaitReply is an outcome of any role", () => {
    const waiting: ChannelOutcome<RefundDeskToolApproval> = ChannelOutcome.awaitReply();
    expectTypeOf(waiting).not.toBeNever();
  });

  it("a class that is not a generated role gives MissingGeneratedTypes", () => {
    class NotARole {
      readonly label = "not a role";
    }
    expectTypeOf<ChannelAsk<NotARole>["input"]>().toEqualTypeOf<MissingGeneratedTypes>();
  });

  it("an @ExternalTask takes input and output; a @ToolApproval no output (#659, #1307)", () => {
    type TaskOptions = Parameters<typeof ExternalTask>[0];
    type ApprovalOptions = Parameters<typeof ToolApproval>[0];
    const base = {
      name: "clarification-external-task",
      description: "A question",
      respondent: PauseRespondent.Delegate,
      timeout: hours(1),
    };
    const task = { ...base, input: ShortlistDto, output: OfferDraftDto };

    expectTypeOf(task).toExtend<TaskOptions>();
    expectTypeOf({ ...task, maxVisits: 2 }).toExtend<TaskOptions>();
    expectTypeOf({ ...base, input: ShortlistDto }).not.toExtend<TaskOptions>();
    expectTypeOf({ ...base, input: RefundCardInputDto }).toExtend<ApprovalOptions>();
    expectTypeOf(task).not.toExtend<ApprovalOptions>();
    // @ts-expect-error — respondent is required: who may answer is never a default
    ToolApproval({
      name: "open-tool-approval",
      description: "Open",
      input: RefundCardInputDto,
      timeout: hours(1),
    });
  });
});
