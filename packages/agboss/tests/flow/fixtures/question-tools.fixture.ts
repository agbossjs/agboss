import { Channel, Injectable, Tool } from "../../../src/components/decorators.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelInterpretation,
  ChannelInterpreter,
} from "../../../src/channels/channel-interpreter.js";
import { Bool, Integer, Text, WorkflowFinishTextDto } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { PiiAction } from "../../../src/pii/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { onStart } from "./paths.js";
import {
  BudgetOwnerQuestionExternalTask,
  InboxBudgetOwnerChannel,
  PurchaseQuestionDto,
  QuestionInbox,
} from "./questions.fixture.js";
import { inline, ExternalTask, Ttl } from "../../../src/index.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { days } from "../../../src/units/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #712 — a question role as an agent's tool: a buyer agent decides itself whether to ask its
 * approver for a limit (`approver-question`, answered by the thread's owner, a code interpreter
 * reads "up to 500"), and places the order with `order-tool` within the answer. The approver's
 * e-mail in the answer is `sensitive`: the model reads it masked. `owner-buyer-agent` asks the
 * budget owner through its channel (`budget-owner-question` of #659, `maxVisits: 2`).
 */

export class ApproverAnswerDto {
  @Bool({ prompt: "whether the purchase may go on" })
  approved!: boolean;

  @Integer({ prompt: "the most it may cost, in dollars", min: 0 })
  limitUsd!: number;

  @Text({ prompt: "who approved", optional: true, sensitive: PiiAction.mask() })
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
  readonly asked: ChannelAsk<ApproverExternalTask>[] = [];
  readonly ordered: OrderRequestDto[] = [];
}

/** Reads "up to 500" / "no" into a limit; anything else is not understood. */
@ChannelInterpreter({
  name: "approver-reply-interpreter",
  description: "Reads the approver's limit",
})
export class ApproverReplyInterpreter {
  interpret(
    input: InputOf<ApproverReplyInterpreter>,
  ): ChannelInterpretation<OutputOf<ApproverReplyInterpreter>> {
    const limit = /up to \$?(\d+)/.exec(input.reply);
    if (limit?.[1] !== undefined)
      return ChannelInterpretation.understood({ approved: true, limitUsd: Number(limit[1]) });
    if (/^no\b/i.test(input.reply.trim()))
      return ChannelInterpretation.understood({ approved: false, limitUsd: 0 });
    return ChannelInterpretation.notUnderstood(`"${input.reply}" names no limit`);
  }
}

@ExternalTask({
  name: "approver-external-task",
  description: "Asks the approver for the most this purchase may cost",
  input: PurchaseQuestionDto,
  output: ApproverAnswerDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
  channelInterpreter: ApproverReplyInterpreter,
  maxVisits: 2,
})
export class ApproverExternalTask {}

/** Posts the question to the desk and waits for the reply. */
@Channel({
  name: "desk-approver-channel",
  description: "The desk",
  deps: [BuyerDesk],
  target: ApproverExternalTask,
  ttl: days(1),
})
export class DeskApproverChannel {
  constructor(private readonly buyerDesk: BuyerDesk) {}

  send(ask: ChannelAsk<ApproverExternalTask>): Promise<ChannelOutcome<ApproverExternalTask>> {
    this.buyerDesk.asked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** Decides at once: up to $100 goes on with a limit of $100. */
@Channel({
  name: "rule-approver-channel",
  description: "Up to $100 at once",
  target: ApproverExternalTask,
  ttl: days(1),
})
export class RuleApproverChannel {
  send(ask: ChannelAsk<ApproverExternalTask>): Promise<ChannelOutcome<ApproverExternalTask>> {
    const approved = ask.input.priceUsd <= 100;
    return Promise.resolve(ChannelOutcome.decided({ approved, limitUsd: approved ? 100 : 0 }));
  }
}

/** Decides at once with what is no answer of the role: a limit below zero. */
@Channel({
  name: "wrong-approver-channel",
  description: "Answers out of range",
  target: ApproverExternalTask,
  ttl: days(1),
})
export class WrongApproverChannel {
  send(): Promise<ChannelOutcome<ApproverExternalTask>> {
    return Promise.resolve(ChannelOutcome.decided({ approved: true, limitUsd: -5 }));
  }
}

/** A channel that cannot be reached. */
@Channel({
  name: "down-approver-channel",
  description: "Unreachable",
  target: ApproverExternalTask,
  ttl: days(1),
})
export class DownApproverChannel {
  send(): Promise<ChannelOutcome<ApproverExternalTask>> {
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
export class OrderTool {
  constructor(private readonly buyerDesk: BuyerDesk) {}

  execute(request: OrderRequestDto): Promise<OrderPlacedDto> {
    this.buyerDesk.ordered.push(request);
    return Promise.resolve({ status: `ordered ${request.item} up to ${String(request.limitUsd)}` });
  }
}

@Agent({
  name: "buyer-agent",
  description: "Buys what is asked, within the approver's limit",
  prompt: inline("Ask the approver for a limit when the price is high, then order within it."),
  model: "test/buyer",
  input: { message: WorkflowStartTextDto },
  tools: [ApproverExternalTask, OrderTool],
})
export class BuyerAgent {}

@Agent({
  name: "owner-buyer-agent",
  description: "Asks the budget owner before it buys",
  prompt: inline("Ask the budget owner for a limit."),
  model: "test/buyer",
  input: { message: WorkflowStartTextDto },
  tools: [BudgetOwnerQuestionExternalTask],
})
export class OwnerBuyerAgent {}

@WorkflowStart({ name: "buyer-workflow-start", description: "d", input: WorkflowStartTextDto })
export class BuyerWorkflowStart {}

@WorkflowFinish({ name: "buyer-workflow-finish", description: "d", output: WorkflowFinishTextDto })
export class BuyerWorkflowFinish {}

@Workflow({
  name: "buyer-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(BuyerWorkflowStart).toAgent(BuyerAgent).toFinish(BuyerWorkflowFinish)],
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OwnerBuyerWorkflowStart).toAgent(OwnerBuyerAgent).toFinish(OwnerBuyerWorkflowFinish),
  ],
  providers: [QuestionInbox],
})
export class OwnerBuyerWorkflow {}

@Application({
  name: "question-tools-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BuyerWorkflow, OwnerBuyerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [DeskApproverChannel, InboxBudgetOwnerChannel],
})
export class QuestionToolsApplication {}

@Application({
  name: "rule-question-tools-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BuyerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [RuleApproverChannel],
})
export class RuleQuestionToolsApplication {}

@Application({
  name: "down-question-tools-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BuyerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [DownApproverChannel],
})
export class DownQuestionToolsApplication {}

@Application({
  name: "wrong-question-tools-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BuyerWorkflow],
  budgets: TEST_BUDGETS,
  providers: [WrongApproverChannel],
})
export class WrongQuestionToolsApplication {}
