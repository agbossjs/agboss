import { describe, expectTypeOf, it } from "vitest";
import type { ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import type { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import type { ToolArguments } from "../../../src/dto/standard/framework.js";
import type {
  InputOf,
  MissingGeneratedTypes,
  OutputOf,
} from "../../../src/flow/generated-types.js";
import type {
  PurchaseQuestionDto,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
  SpendingLimitReplyInterpreter,
} from "../fixtures/questions.fixture.js";
import { RefundCardInputDto, type RefundApprovalChannel } from "../fixtures/refunds.fixture.js";
import { OfferDraftDto, ShortlistDto } from "../fixtures/dtos.js";
import { ApproverQuestion } from "../fixtures/question-tools.fixture.js";
import { callTool, type ToolCallTurn } from "../../../src/testing/index.js";

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

  it("AC1: a question role (ask / answer) compiles; beside approves it does not (#659)", () => {
    type RoleOptions = Parameters<typeof ChannelRole>[0];
    const role = {
      name: "clarification-question",
      description: "A question",
      answeredBy: PauseAnswerer.Channel,
    };
    const question = { ...role, ask: ShortlistDto, answer: OfferDraftDto };
    const both = { ...question, approves: RefundCardInputDto };

    expectTypeOf(question).toExtend<RoleOptions>();
    expectTypeOf({ ...question, maxVisits: 2 }).toExtend<RoleOptions>();
    expectTypeOf(both).not.toExtend<RoleOptions>();
    expectTypeOf({ ...role, ask: ShortlistDto }).not.toExtend<RoleOptions>();
    expectTypeOf({
      ...role,
      approves: RefundCardInputDto,
      maxVisits: 2,
    }).not.toExtend<RoleOptions>();
    expectTypeOf({ ...role, approves: RefundCardInputDto }).toExtend<RoleOptions>();
    // @ts-expect-error — answeredBy is required: who may answer is never a default
    ChannelRole({ name: "open-channel", description: "Open", approves: RefundCardInputDto });
    expectTypeOf(ChannelRole).toBeFunction();
  });
});

describe("#659 AC6: a question role's ask and answer type its channel and its interpreter", () => {
  it("ask.value is the role's ask DTO", () => {
    expectTypeOf<ChannelAsk<SpendingLimitQuestion>["value"]>().toEqualTypeOf<PurchaseQuestionDto>();
  });

  it("a decided outcome takes the role's answer DTO", () => {
    const decided: ChannelOutcome<SpendingLimitQuestion> = ChannelOutcome.decided({
      approved: true,
      limitUsd: 500,
    });
    expectTypeOf(decided).not.toBeNever();
    // @ts-expect-error — limitUsd is required by SpendingLimitAnswerDto
    const partial: ChannelOutcome<SpendingLimitQuestion> = ChannelOutcome.decided({
      approved: true,
    });
    expectTypeOf(partial).not.toBeNever();
  });

  it("the interpreter reads { ask, reply } and gives the answer", () => {
    expectTypeOf<InputOf<SpendingLimitReplyInterpreter>>().toEqualTypeOf<{
      readonly ask: PurchaseQuestionDto;
      readonly reply: string;
    }>();
    expectTypeOf<OutputOf<SpendingLimitReplyInterpreter>>().toEqualTypeOf<SpendingLimitAnswerDto>();
  });

  it("the step's input and output: the ask in, the answer out", () => {
    expectTypeOf<OutputOf<SpendingLimitQuestion>>().toEqualTypeOf<SpendingLimitAnswerDto>();
    expectTypeOf<
      InputOf<SpendingLimitQuestion>["question"]["value"]
    >().toEqualTypeOf<PurchaseQuestionDto>();
  });
});

describe("#712: a question role an agent asks is typed by its role", () => {
  it("callTool(Role, args) takes the role's ask; another shape does not compile", () => {
    expectTypeOf(callTool(ApproverQuestion, { item: "laptop", priceUsd: 900 })).toEqualTypeOf<
      ToolCallTurn<"approver-question">
    >();
    // @ts-expect-error — the ask's priceUsd is a number
    callTool(ApproverQuestion, { item: "laptop", priceUsd: "900" });
    expectTypeOf<ChannelAsk<ApproverQuestion>["value"]>().toEqualTypeOf<PurchaseQuestionDto>();
  });
});
