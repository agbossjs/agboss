import { Channel, Injectable, Tool, type ToolHandler } from "../../../src/components/decorators.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
  ReplyInterpretation,
  ReplyInterpreter,
  type ReplyInterpreterHandler,
} from "../../../src/channels/channel-role.decorator.js";
import { Flag, Integer, Text, WorkflowFinishTextDto } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { PiiAction } from "../../../src/pii/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { start } from "./paths.js";
import {
  BudgetOwnerQuestion,
  InboxBudgetOwnerChannel,
  PurchaseQuestionDto,
  QuestionInbox,
} from "./questions.fixture.js";

/**
 * #712 — a question role as an agent's tool: a buyer agent decides itself whether to ask its
 * approver for a limit (`approver-question`, answered by the thread's owner, a code interpreter
 * reads "up to 500"), and places the order with `order-tool` within the answer. The approver's
 * e-mail in the answer is `sensitive`: the model reads it masked. `owner-buyer-agent` asks the
 * budget owner through its channel (`budget-owner-question` of #659, `maxVisits: 2`).
 */

export class ApproverAnswerDto {
  @Flag({ prompt: "whether the purchase may go on" })
  approved!: boolean;

  @Integer({ prompt: "the most it may cost, in dollars", min: 0 })
  limitUsd!: number;

  @Text({ prompt: "who approved", optional: true, sensitive: PiiAction.replaceWithKind() })
  approverEmail?: string;
}

export class OrderRequestDto {
  @Text({ prompt: "what is bought" })
  item!: string;

  @Integer({ prompt: "the most it may cost, in dollars", min: 0 })
  limitUsd!: number;
}

export class OrderPlacedDto {
  @Text()
  status!: string;
}

/** What the approver's channel was asked and the order tool did, across the instances of a test. */
@Injectable()
export class BuyerDesk {
  readonly asked: ChannelAsk<ApproverQuestion>[] = [];
  readonly ordered: OrderRequestDto[] = [];
}

/** Reads "up to 500" / "no" into a limit; anything else is not understood. */
@ReplyInterpreter({
  name: "approver-reply-interpreter",
  description: "Reads the approver's limit",
  decidedBy: DecidedBy.Code,
})
export class ApproverReplyInterpreter implements ReplyInterpreterHandler<ApproverReplyInterpreter> {
  interpret(
    input: InputOf<ApproverReplyInterpreter>,
  ): ReplyInterpretation<OutputOf<ApproverReplyInterpreter>> {
    const limit = /up to \$?(\d+)/.exec(input.reply);
    if (limit?.[1] !== undefined)
      return ReplyInterpretation.understood({ approved: true, limitUsd: Number(limit[1]) });
    if (/^no\b/i.test(input.reply.trim()))
      return ReplyInterpretation.understood({ approved: false, limitUsd: 0 });
    return ReplyInterpretation.notUnderstood({ reason: `"${input.reply}" names no limit` });
  }
}

@ChannelRole({
  name: "approver-question",
  description: "Asks the approver for the most this purchase may cost",
  ask: PurchaseQuestionDto,
  answer: ApproverAnswerDto,
  answeredBy: PauseAnswerer.ThreadOwner,
  replyInterpreter: ApproverReplyInterpreter,
  maxVisits: 2,
})
export abstract class ApproverQuestion extends ChannelOf<ApproverQuestion> {}

/** Posts the question to the desk and waits for the reply. */
@Channel({ name: "desk-approver-channel", description: "The desk", deps: [BuyerDesk] })
export class DeskApproverChannel extends ApproverQuestion {
  constructor(private readonly buyerDesk: BuyerDesk) {
    super();
  }

  send(ask: ChannelAsk<ApproverQuestion>): Promise<ChannelOutcome<ApproverQuestion>> {
    this.buyerDesk.asked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** Decides at once: up to $100 goes on with a limit of $100. */
@Channel({ name: "rule-approver-channel", description: "Up to $100 at once" })
export class RuleApproverChannel extends ApproverQuestion {
  send(ask: ChannelAsk<ApproverQuestion>): Promise<ChannelOutcome<ApproverQuestion>> {
    const approved = ask.value.priceUsd <= 100;
    return Promise.resolve(ChannelOutcome.decided({ approved, limitUsd: approved ? 100 : 0 }));
  }
}

/** A channel that cannot be reached. */
@Channel({ name: "down-approver-channel", description: "Unreachable" })
export class DownApproverChannel extends ApproverQuestion {
  send(): Promise<ChannelOutcome<ApproverQuestion>> {
    return Promise.reject(new Error("the approvals service is down"));
  }
}

@Tool({
  name: "order-tool",
  description: "Places an order within a limit",
  input: OrderRequestDto,
  output: OrderPlacedDto,
  deps: [BuyerDesk],
})
export class OrderTool implements ToolHandler<OrderRequestDto, OrderPlacedDto> {
  constructor(private readonly buyerDesk: BuyerDesk) {}

  run(request: OrderRequestDto): Promise<OrderPlacedDto> {
    this.buyerDesk.ordered.push(request);
    return Promise.resolve({ status: `ordered ${request.item} up to ${String(request.limitUsd)}` });
  }
}

@Agent({
  name: "buyer-agent",
  description: "Buys what is asked, within the approver's limit",
  prompt: "Ask the approver for a limit when the price is high, then order within it.",
  model: "test/buyer",
  input: { message: WorkflowStartTextDto },
  tools: [ApproverQuestion, OrderTool],
})
export class BuyerAgent {}

@Agent({
  name: "owner-buyer-agent",
  description: "Asks the budget owner before it buys",
  prompt: "Ask the budget owner for a limit.",
  model: "test/buyer",
  input: { message: WorkflowStartTextDto },
  tools: [BudgetOwnerQuestion],
})
export class OwnerBuyerAgent {}

@WorkflowStart({ name: "buyer-workflow-start", description: "d", input: WorkflowStartTextDto })
export class BuyerWorkflowStart {}

@WorkflowFinish({ name: "buyer-workflow-finish", description: "d", output: WorkflowFinishTextDto })
export class BuyerWorkflowFinish {}

@Workflow({
  name: "buyer-workflow",
  version: "1.0.0",
  flow: [
    start(BuyerWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(BuyerAgent)
      .toFinish(BuyerWorkflowFinish),
  ],
  providers: [BuyerDesk],
})
export class BuyerWorkflow {}

@WorkflowStart({
  name: "owner-buyer-workflow-start",
  description: "d",
  input: WorkflowStartTextDto,
})
export class OwnerBuyerWorkflowStart {}

@WorkflowFinish({
  name: "owner-buyer-workflow-finish",
  description: "d",
  output: WorkflowFinishTextDto,
})
export class OwnerBuyerWorkflowFinish {}

@Workflow({
  name: "owner-buyer-workflow",
  version: "1.0.0",
  flow: [
    start(OwnerBuyerWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OwnerBuyerAgent)
      .toFinish(OwnerBuyerWorkflowFinish),
  ],
  providers: [QuestionInbox],
})
export class OwnerBuyerWorkflow {}

@Application({
  name: "question-tools-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BuyerWorkflow, OwnerBuyerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [DeskApproverChannel, InboxBudgetOwnerChannel],
})
export class QuestionToolsApplication {}

@Application({
  name: "rule-question-tools-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BuyerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [RuleApproverChannel],
})
export class RuleQuestionToolsApplication {}

@Application({
  name: "down-question-tools-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BuyerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [DownApproverChannel],
})
export class DownQuestionToolsApplication {}
