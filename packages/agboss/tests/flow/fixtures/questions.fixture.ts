import { Channel, Injectable } from "../../../src/components/decorators.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelInterpretation,
  ChannelInterpreter,
} from "../../../src/channels/channel-interpreter.js";
import { Bool, Integer, Text } from "../../../src/dto/index.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { PiiAction } from "../../../src/pii/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { onExternalTask, onStart, toFinish, toExternalTask } from "./paths.js";
import { QuestionFailedError } from "../../../src/flow/runtime/errors.js";
import { inline, ExternalTask, Ttl } from "../../../src/index.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { days } from "../../../src/units/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

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

  @Text({ prompt: "who asks", optional: true, sensitive: PiiAction.mask() })
  requester?: string;
}

export class SpendingLimitAnswerDto {
  @Bool({ prompt: "whether the purchase may go on" })
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
  readonly asked: ChannelAsk<SpendingLimitQuestionExternalTask>[] = [];
  readonly ownerAsked: ChannelAsk<BudgetOwnerQuestionExternalTask>[] = [];
  readonly placed: SpendingLimitAnswerDto[] = [];
}

/** Reads "up to 500" / "no" into a limit; anything else is not understood. */
@ChannelInterpreter({
  name: "spending-limit-reply-interpreter",
  description: "Reads the owner's limit",
})
export class SpendingLimitReplyInterpreter {
  interpret(
    input: InputOf<SpendingLimitReplyInterpreter>,
  ): ChannelInterpretation<OutputOf<SpendingLimitReplyInterpreter>> {
    const limit = /up to \$?(\d+)/.exec(input.reply);
    if (limit?.[1] !== undefined)
      return ChannelInterpretation.understood({ approved: true, limitUsd: Number(limit[1]) });
    if (/^no\b/i.test(input.reply.trim()))
      return ChannelInterpretation.understood({ approved: false, limitUsd: 0 });
    return ChannelInterpretation.notUnderstood(`"${input.reply}" names no limit`);
  }
}

@ExternalTask({
  name: "spending-limit-question-external-task",
  description: "Asks the thread's owner for this purchase's spending limit",
  input: PurchaseQuestionDto,
  output: SpendingLimitAnswerDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
  channelInterpreter: SpendingLimitReplyInterpreter,
})
export class SpendingLimitQuestionExternalTask {}

/** Posts the question to the owner's inbox and waits for the reply. */
@Channel({
  name: "inbox-spending-limit-channel",
  description: "The owner's inbox",
  deps: [ExecutionContext, QuestionInbox],
  target: SpendingLimitQuestionExternalTask,
  ttl: days(1),
})
export class InboxSpendingLimitChannel {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly questionInbox: QuestionInbox,
  ) {}

  send(
    ask: ChannelAsk<SpendingLimitQuestionExternalTask>,
  ): Promise<ChannelOutcome<SpendingLimitQuestionExternalTask>> {
    this.executionContext.signal.throwIfAborted();
    this.questionInbox.asked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** Decides at once: a purchase of $100 or less goes on with a limit of $100. */
@Channel({
  name: "rule-spending-limit-channel",
  description: "Up to $100 at once",
  target: SpendingLimitQuestionExternalTask,
  ttl: days(1),
})
export class RuleSpendingLimitChannel {
  send(
    ask: ChannelAsk<SpendingLimitQuestionExternalTask>,
  ): Promise<ChannelOutcome<SpendingLimitQuestionExternalTask>> {
    return Promise.resolve(
      ChannelOutcome.decided({ approved: ask.input.priceUsd <= 100, limitUsd: 100 }),
    );
  }
}

/** A budget owner's words read by a chat model. */
@ChannelInterpreter({
  name: "budget-owner-reply-interpreter",
  description: "Reads the budget owner's limit",
  model: "test/m",
  prompt: inline("The budget owner names the most this purchase may cost."),
})
export class BudgetOwnerReplyInterpreter {}

@ExternalTask({
  name: "budget-owner-question-external-task",
  description: "Asks a budget owner, authenticated by the channel",
  input: PurchaseQuestionDto,
  output: SpendingLimitAnswerDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
  channelInterpreter: BudgetOwnerReplyInterpreter,
  maxVisits: 2,
})
export class BudgetOwnerQuestionExternalTask {}

@Channel({
  name: "inbox-budget-owner-channel",
  description: "The budget owners' inbox",
  deps: [QuestionInbox],
  target: BudgetOwnerQuestionExternalTask,
  ttl: days(1),
})
export class InboxBudgetOwnerChannel {
  constructor(private readonly questionInbox: QuestionInbox) {}

  send(
    ask: ChannelAsk<BudgetOwnerQuestionExternalTask>,
  ): Promise<ChannelOutcome<BudgetOwnerQuestionExternalTask>> {
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
    const [item = "", price = "0"] = message.text.split(" for ");
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
    const { item, priceUsd } = input.question;
    const { approved, limitUsd } = input.answer;
    this.questionInbox.placed.push(input.answer);
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
    if (answer.limitUsd >= question.priceUsd)
      return Promise.resolve({ status: `placed within ${String(answer.limitUsd)}` });
    const { item, priceUsd, requester } = question;
    return Promise.resolve({ item, priceUsd, requester });
  }
}

@Workflow({
  name: "purchase-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PurchaseWorkflowStart)
      .toAction(DraftQuestionAction)
      .toExternalTask(SpendingLimitQuestionExternalTask)
      .onError(QuestionFailedError, toFinish(PurchaseUnaskedWorkflowFinish))
      .toAction(PlacePurchaseAction)
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OwnerPurchaseWorkflowStart)
      .toAction(DraftQuestionAction)
      .toExternalTask(BudgetOwnerQuestionExternalTask),
    onExternalTask(BudgetOwnerQuestionExternalTask)
      .toAction(CheckLimitAction)
      .toOneOf([
        toFinish(OwnerPurchaseWorkflowFinish),
        toExternalTask(BudgetOwnerQuestionExternalTask),
      ]),
  ],
  providers: [QuestionInbox],
})
export class OwnerPurchaseWorkflow {}

@Application({
  name: "questions-application",
  modelProvider: TestModelProvider,
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
