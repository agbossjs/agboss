import { Window2Memory } from "../../helpers/window-memory.js";
import { Channel, Injectable, Tool } from "../../../src/components/decorators.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { Integer, Text } from "../../../src/dto/index.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { onStart } from "./paths.js";
import { inline, ToolApproval, Ttl } from "../../../src/index.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { days } from "../../../src/units/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #267 PR 1 — a card refund approved through a channel role: the tool names the role, the role
 * says what it approves and who answers, and each application provides one implementation of it
 * (a Slack-like one that waits for the reply, or a rule that decides small refunds at once).
 */

export class RefundCardInputDto {
  @Text({ prompt: "the order id" })
  orderId!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

export class RefundCardOutputDto {
  @Text()
  status!: string;
}

/** What the channels posted and what the tool did. */
@Injectable()
export class RefundDesk {
  readonly posted: ChannelAsk<RefundDeskToolApproval>[] = [];
  readonly refunded: string[] = [];
  readonly tenants: string[] = [];
}

@ToolApproval({
  name: "refund-gate-tool-approval",
  description: "Approves card refunds",
  input: RefundCardInputDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class RefundDeskToolApproval {}

/** Posts the ask (a Slack message with the pause's id as its reply key) and waits for the reply. */
@Channel({
  name: "slack-refund-approval-channel",
  description: "Asks a finance manager",
  deps: [ExecutionContext, RefundDesk],
  target: RefundDeskToolApproval,
  ttl: days(1),
})
export class SlackRefundApprovalChannel {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly refundDesk: RefundDesk,
  ) {}

  send(ask: ChannelAsk<RefundDeskToolApproval>): Promise<ChannelOutcome<RefundDeskToolApproval>> {
    this.refundDesk.posted.push(ask);
    this.refundDesk.tenants.push(this.executionContext.tenant.tenantId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** A rule-based implementation: small refunds are approved at once, the rest refused at once. */
@Channel({
  name: "rule-refund-approval-channel",
  description: "Up to $50 at once",
  target: RefundDeskToolApproval,
  ttl: days(1),
})
export class RuleRefundApprovalChannel {
  send(ask: ChannelAsk<RefundDeskToolApproval>): Promise<ChannelOutcome<RefundDeskToolApproval>> {
    const isSmall = ask.input.amountCents <= 5000;
    return Promise.resolve(
      isSmall
        ? ChannelOutcome.decided({ approved: true })
        : ChannelOutcome.decided({ approved: false, reason: "over $50" }),
    );
  }
}

@Tool({
  name: "refund-card-tool",
  description: "Refunds a card payment",
  input: RefundCardInputDto,
  output: RefundCardOutputDto,
  approval: RefundDeskToolApproval,
  deps: [RefundDesk],
})
export class RefundCardTool {
  constructor(private readonly refundDesk: RefundDesk) {}

  execute({ orderId }: RefundCardInputDto): Promise<RefundCardOutputDto> {
    this.refundDesk.refunded.push(orderId);
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

@Agent({
  name: "refund-clerk-agent",
  description: "Refunds card payments",
  prompt: inline("Refund what is asked."),
  model: "test/refund-clerk",
  input: { message: WorkflowStartTextDto },
  output: RefundCardOutputDto,
  price: { inputPerMTok: 1, outputPerMTok: 10 },
  tools: [RefundCardTool],
})
export class RefundClerkAgent {}

@WorkflowStart({
  name: "refund-workflow-start",
  description: "A refund request",
  input: WorkflowStartTextDto,
})
export class RefundWorkflowStart {}

@WorkflowFinish({
  name: "refund-workflow-finish",
  description: "The answer",
  output: RefundCardOutputDto,
})
export class RefundWorkflowFinish {}

@Workflow({
  name: "card-refunds-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RefundWorkflowStart)
      .toAgent(RefundClerkAgent)
      .toFinish(RefundWorkflowFinish),
  ],
  defaults: { router: { model: "typesafe/jev-test" } },
  memory: Window2Memory,
  providers: [RefundDesk],
})
export class CardRefundsWorkflow {}

@Application({
  name: "slack-refunds-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CardRefundsWorkflow],
  budgets: TEST_BUDGETS,
  providers: [SlackRefundApprovalChannel],
})
export class SlackRefundsApplication {}

/** The same application with no `modelProvider`: a model judge of an eval suite finds none. */
@Application({
  name: "unserved-refunds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CardRefundsWorkflow],
  budgets: TEST_BUDGETS,
  providers: [SlackRefundApprovalChannel],
})
export class UnservedRefundsApplication {}

@Application({
  name: "rule-refunds-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CardRefundsWorkflow],
  budgets: TEST_BUDGETS,
  providers: [RuleRefundApprovalChannel],
})
export class RuleRefundsApplication {}

/** No implementation of the role: `[di.missing-implementation]`. */
@Application({
  name: "unprovided-refunds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CardRefundsWorkflow],
  budgets: TEST_BUDGETS,
})
export class UnprovidedRefundsApplication {}

/** Two implementations: `[di.ambiguous-implementation]`. */
@Application({
  name: "doubled-refunds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CardRefundsWorkflow],
  budgets: TEST_BUDGETS,
  providers: [SlackRefundApprovalChannel, RuleRefundApprovalChannel],
})
export class DoubledRefundsApplication {}
