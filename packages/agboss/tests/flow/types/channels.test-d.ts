import { describe, expectTypeOf, it } from "vitest";
import type { ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import type { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import type { ToolArguments } from "../../../src/dto/standard/framework.js";
import type { MissingGeneratedTypes } from "../../../src/flow/generated-types.js";
import { RefundCardInputDto, type RefundApprovalChannel } from "../fixtures/refunds.fixture.js";
import { OfferDraftDto, ShortlistDto } from "../fixtures/dtos.js";

/**
 * #267 AC6 (PR 1): a channel role's `approves` types the ask's `arguments` and the decision's
 * `overrideArguments` — through the generated `ChannelRoles` table (`check:types`).
 */

describe("#267 AC6: approves types arguments", () => {
  it("ask.value.arguments is the role's approves DTO", () => {
    expectTypeOf<
      ChannelAsk<RefundApprovalChannel>["value"]["arguments"]
    >().toEqualTypeOf<RefundCardInputDto>();
    expectTypeOf<ChannelAsk<RefundApprovalChannel>["pauseId"]>().toEqualTypeOf<string>();
  });

  it("a decided outcome takes the role's decision, overrideArguments typed by the same DTO", () => {
    const decided: ChannelOutcome<RefundApprovalChannel> = ChannelOutcome.decided({
      approved: true,
      by: "rule",
      overrideArguments: { orderId: "A-1", amountCents: 100 },
    });
    expectTypeOf(decided).not.toBeNever();
    // @ts-expect-error — overrideArguments must be a RefundCardInputDto (amountCents missing)
    const wrong: ChannelOutcome<RefundApprovalChannel> = ChannelOutcome.decided({
      approved: true,
      by: "rule",
      overrideArguments: { orderId: "A-1" },
    });
    expectTypeOf(wrong).not.toBeNever();
    // @ts-expect-error — the decision needs approved and by
    const empty: ChannelOutcome<RefundApprovalChannel> = ChannelOutcome.decided({});
    expectTypeOf(empty).not.toBeNever();
  });

  it("awaitReply is an outcome of any role", () => {
    const waiting: ChannelOutcome<RefundApprovalChannel> = ChannelOutcome.awaitReply();
    expectTypeOf(waiting).not.toBeNever();
  });

  it("the built-in channels approve any tool: untyped arguments", () => {
    expectTypeOf<
      ChannelAsk<TerminalUserChannel>["value"]["arguments"]
    >().toEqualTypeOf<ToolArguments>();
  });

  it("a class that is not a generated role gives MissingGeneratedTypes", () => {
    class NotARole {
      readonly label = "not a role";
    }
    expectTypeOf<ChannelAsk<NotARole>["value"]>().toEqualTypeOf<MissingGeneratedTypes>();
  });

  it("both forms in one role do not compile", () => {
    // @ts-expect-error — approves and ask / answer together: two forms, never both
    ChannelRole({
      name: "both-channel",
      description: "Both",
      approves: RefundCardInputDto,
      ask: ShortlistDto,
      answer: OfferDraftDto,
      answeredBy: PauseAnswerer.Channel,
    });
    // @ts-expect-error — answeredBy is required: who may answer is never a default
    ChannelRole({ name: "open-channel", description: "Open", approves: RefundCardInputDto });
    expectTypeOf(ChannelRole).toBeFunction();
  });
});
