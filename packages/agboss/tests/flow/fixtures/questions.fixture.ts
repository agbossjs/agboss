import { Channel, Injectable } from "../../../src/components/decorators.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
  ReplyInterpretation,
  ReplyInterpreter,
  type ReplyInterpreterHandler,
} from "../../../src/channels/channel-role.decorator.js";
import { Flag, Integer, Text } from "../../../src/dto/index.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf, variant } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { PiiAction } from "../../../src/pii/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { caseOf, question, start, toFinish } from "./paths.js";
import { QuestionFailedError } from "../../../src/flow/runtime/errors.js";

/**
 * #659 — question roles: a purchase asks its budget owner for a spending limit before it is placed.
 * `spending-limit-question` is answered by the thread's owner (a code interpreter reads "up to 500"),
 * `budget-owner-question` through its channel (a model interpreter), asked again on a cycle while the
 * answer is below the price (`maxVisits: 2`). What the channels were asked is in `QuestionInbox`.
 */

export class PurchaseQuestionDto {
  @Text({ prompt: "what is bought" })
  item!: string;

  @Integer({ prompt: "its price in dollars", min: 0 })
  priceUsd!: number;

  @Text({ prompt: "who asks", optional: true, sensitive: PiiAction.replaceWithKind() })
  requester?: string;
}

export class SpendingLimitAnswerDto {
  @Flag({ prompt: "whether the purchase may go on" })
  approved!: boolean;

  @Integer({ prompt: "the most it may cost, in dollars", min: 0 })
  limitUsd!: number;
}

export class PurchasePlacedDto {
  @Text()
  status!: string;
}

/** What the channels were asked and the actions did, across the instances of a test. */
@Injectable()
export class QuestionInbox {
  readonly asked: ChannelAsk<SpendingLimitQuestion>[] = [];
  readonly ownerAsked: ChannelAsk<BudgetOwnerQuestion>[] = [];
  readonly placed: SpendingLimitAnswerDto[] = [];
}

/** Reads "up to 500" / "no" into a limit; anything else is not understood. */
@ReplyInterpreter({
  name: "spending-limit-reply-interpreter",
  description: "Reads the owner's limit",
  decidedBy: DecidedBy.Code,
})
export class SpendingLimitReplyInterpreter implements ReplyInterpreterHandler<SpendingLimitReplyInterpreter> {
  interpret(
    input: InputOf<SpendingLimitReplyInterpreter>,
  ): ReplyInterpretation<OutputOf<SpendingLimitReplyInterpreter>> {
    const limit = /up to \$?(\d+)/.exec(input.reply);
    if (limit?.[1] !== undefined)
      return ReplyInterpretation.understood({ approved: true, limitUsd: Number(limit[1]) });
    if (/^no\b/i.test(input.reply.trim()))
      return ReplyInterpretation.understood({ approved: false, limitUsd: 0 });
    return ReplyInterpretation.notUnderstood({ reason: `"${input.reply}" names no limit` });
  }
}

@ChannelRole({
  name: "spending-limit-question",
  description: "Asks the thread's owner for this purchase's spending limit",
  ask: PurchaseQuestionDto,
  answer: SpendingLimitAnswerDto,
  answerer: PauseAnswerer.ThreadOwner,
  replyInterpreter: SpendingLimitReplyInterpreter,
})
export abstract class SpendingLimitQuestion extends ChannelOf<SpendingLimitQuestion> {}

/** Posts the question to the owner's inbox and waits for the reply. */
@Channel({
  name: "inbox-spending-limit-channel",
  description: "The owner's inbox",
  deps: [ExecutionContext, QuestionInbox],
})
export class InboxSpendingLimitChannel extends SpendingLimitQuestion {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly questionInbox: QuestionInbox,
  ) {
    super();
  }

  send(ask: ChannelAsk<SpendingLimitQuestion>): Promise<ChannelOutcome<SpendingLimitQuestion>> {
    this.executionContext.signal.throwIfAborted();
    this.questionInbox.asked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** Decides at once: a purchase of $100 or less goes on with a limit of $100. */
@Channel({ name: "rule-spending-limit-channel", description: "Up to $100 at once" })
export class RuleSpendingLimitChannel extends SpendingLimitQuestion {
  send(ask: ChannelAsk<SpendingLimitQuestion>): Promise<ChannelOutcome<SpendingLimitQuestion>> {
    return Promise.resolve(
      ChannelOutcome.decided({ approved: ask.value.priceUsd <= 100, limitUsd: 100 }),
    );
  }
}

/** A budget owner's words read by a chat model. */
@ReplyInterpreter({
  name: "budget-owner-reply-interpreter",
  description: "Reads the budget owner's limit",
  decidedBy: DecidedBy.Model,
  model: "test/m",
  prompt: "The budget owner names the most this purchase may cost.",
})
export class BudgetOwnerReplyInterpreter {}

@ChannelRole({
  name: "budget-owner-question",
  description: "Asks a budget owner, authenticated by the channel",
  ask: PurchaseQuestionDto,
  answer: SpendingLimitAnswerDto,
  answerer: PauseAnswerer.Channel,
  replyInterpreter: BudgetOwnerReplyInterpreter,
  maxVisits: 2,
})
export abstract class BudgetOwnerQuestion extends ChannelOf<BudgetOwnerQuestion> {}

@Channel({
  name: "inbox-budget-owner-channel",
  description: "The budget owners' inbox",
  deps: [QuestionInbox],
})
export class InboxBudgetOwnerChannel extends BudgetOwnerQuestion {
  constructor(private readonly questionInbox: QuestionInbox) {
    super();
  }

  send(ask: ChannelAsk<BudgetOwnerQuestion>): Promise<ChannelOutcome<BudgetOwnerQuestion>> {
    this.questionInbox.ownerAsked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({ name: "purchase-workflow-start", description: "d", input: WorkflowStartTextDto })
export class PurchaseWorkflowStart {}

@WorkflowFinish({ name: "purchase-workflow-finish", description: "d", output: PurchasePlacedDto })
export class PurchaseWorkflowFinish {}

/** The question could not be asked: the purchase is handed back as it was asked. */
@WorkflowFinish({
  name: "purchase-unasked-workflow-finish",
  description: "d",
  output: PurchaseQuestionDto,
})
export class PurchaseUnaskedWorkflowFinish {}

/** The question from the request: `<item> for <price>`. */
@Action({
  name: "draft-question-action",
  description: "Drafts the question",
  input: { message: WorkflowStartTextDto },
  output: PurchaseQuestionDto,
})
export class DraftQuestionAction implements ActionHandler<DraftQuestionAction> {
  execute({ message }: InputOf<DraftQuestionAction>): Promise<OutputOf<DraftQuestionAction>> {
    const [item = "", price = "0"] = message.value.text.split(" for ");
    return Promise.resolve({ item, priceUsd: Number(price), requester: "alice" });
  }
}

/** Places the purchase within the answered limit. */
@Action({
  name: "place-purchase-action",
  description: "Places the purchase",
  input: { question: PurchaseQuestionDto, answer: SpendingLimitAnswerDto },
  output: PurchasePlacedDto,
  deps: [QuestionInbox],
})
export class PlacePurchaseAction implements ActionHandler<PlacePurchaseAction> {
  constructor(private readonly questionInbox: QuestionInbox) {}

  execute(input: InputOf<PlacePurchaseAction>): Promise<OutputOf<PlacePurchaseAction>> {
    const { item, priceUsd } = input.question.value;
    const { approved, limitUsd } = input.answer.value;
    this.questionInbox.placed.push(input.answer.value);
    const within = approved && priceUsd <= limitUsd;
    const status = within
      ? `placed ${item} at ${String(priceUsd)} within ${String(limitUsd)}`
      : `declined ${item}`;
    return Promise.resolve({ status });
  }
}

/** Below the price: the owner is asked again, the price stated anew. */
@Action({
  name: "check-limit-action",
  description: "Checks the limit against the price",
  input: { question: PurchaseQuestionDto, answer: SpendingLimitAnswerDto },
  output: oneOf(PurchasePlacedDto, PurchaseQuestionDto),
})
export class CheckLimitAction implements ActionHandler<CheckLimitAction> {
  execute({ question, answer }: InputOf<CheckLimitAction>): Promise<OutputOf<CheckLimitAction>> {
    if (answer.value.limitUsd >= question.value.priceUsd)
      return Promise.resolve(
        variant(PurchasePlacedDto, { status: `placed within ${String(answer.value.limitUsd)}` }),
      );
    const { item, priceUsd, requester } = question.value;
    return Promise.resolve(variant(PurchaseQuestionDto, { item, priceUsd, requester }));
  }
}

@Workflow({
  name: "purchase-workflow",
  version: "1.0.0",
  flow: [
    start(PurchaseWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(DraftQuestionAction)
      .returns(PurchaseQuestionDto)
      .toQuestion(SpendingLimitQuestion)
      .onError(QuestionFailedError, toFinish(PurchaseUnaskedWorkflowFinish))
      .returns(SpendingLimitAnswerDto)
      .toAction(PlacePurchaseAction)
      .returns(PurchasePlacedDto)
      .toFinish(PurchaseWorkflowFinish),
  ],
  providers: [QuestionInbox],
})
export class PurchaseWorkflow {}

@WorkflowStart({
  name: "owner-purchase-workflow-start",
  description: "d",
  input: WorkflowStartTextDto,
})
export class OwnerPurchaseWorkflowStart {}

@WorkflowFinish({
  name: "owner-purchase-workflow-finish",
  description: "d",
  output: PurchasePlacedDto,
})
export class OwnerPurchaseWorkflowFinish {}

@Workflow({
  name: "owner-purchase-workflow",
  version: "1.0.0",
  flow: [
    start(OwnerPurchaseWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(DraftQuestionAction)
      .returns(PurchaseQuestionDto)
      .toQuestion(BudgetOwnerQuestion),
    question(BudgetOwnerQuestion)
      .returns(SpendingLimitAnswerDto, { about: PurchaseQuestionDto })
      .toAction(CheckLimitAction)
      .returns(oneOf(PurchasePlacedDto, PurchaseQuestionDto))
      .switch(
        caseOf(PurchasePlacedDto).toFinish(OwnerPurchaseWorkflowFinish),
        caseOf(PurchaseQuestionDto).toQuestion(BudgetOwnerQuestion),
      ),
  ],
  providers: [QuestionInbox],
})
export class OwnerPurchaseWorkflow {}

@Application({
  name: "questions-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PurchaseWorkflow, OwnerPurchaseWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InboxSpendingLimitChannel, InboxBudgetOwnerChannel],
})
export class QuestionsApplication {}

@Application({
  name: "rule-questions-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PurchaseWorkflow],
  budgets: TEST_BUDGETS,
  providers: [RuleSpendingLimitChannel],
})
export class RuleQuestionsApplication {}
