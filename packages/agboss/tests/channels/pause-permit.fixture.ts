import {
  Agent,
  Channel,
  ChannelOutcome,
  ExternalTask,
  Injectable,
  PauseRespondent,
  Tool,
  ToolApproval,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  Ttl,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import type { AnswerPermissionContext } from "../../src/channels/pause-contexts.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { days, hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import {
  DraftQuestionAction,
  PlacePurchaseAction,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  QuestionInbox,
  SpendingLimitAnswerDto,
} from "../flow/fixtures/questions.fixture.js";

/**
 * #1307c: a target's `permitAnswer` is called by the resume (a delegate approval whose hook the test
 * steers), and an owner's target with no channel (a tool approval and an external task) asks nobody.
 */

/** What the hook of the test answers, and what it was asked. */
@Injectable()
export class PermitPolicy {
  verdict: unknown = true;
  asked: unknown[] = [];
}

export class PermitRefundDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class PermitRefundDoneDto {
  @Text()
  status!: string;
}

@ToolApproval({
  name: "gated-refund-tool-approval",
  description: "Approves refunds, a hook decides who may answer",
  input: PermitRefundDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
  deps: [PermitPolicy],
})
export class GatedRefundToolApproval {
  constructor(private readonly policy: PermitPolicy) {}

  permitAnswer(ctx: AnswerPermissionContext<GatedRefundToolApproval>): boolean {
    this.policy.asked.push(ctx);
    if (this.policy.verdict === "throw") throw new Error("the hook failed");
    // the test steers any verdict, also ones that are no boolean
    return this.policy.verdict as boolean;
  }
}

@Channel({
  name: "gated-refund-channel",
  description: "The desk",
  target: GatedRefundToolApproval,
  ttl: days(7),
  deps: [PermitPolicy],
})
export class GatedRefundChannel {
  readonly asked: ChannelAsk<GatedRefundToolApproval>[] = [];

  send(ask: ChannelAsk<GatedRefundToolApproval>): Promise<ChannelOutcome<GatedRefundToolApproval>> {
    this.asked.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Injectable()
export class PermitRefunds {
  readonly refunded: string[] = [];
}

@Tool({
  name: "gated-refund-tool",
  description: "Refunds an order",
  input: PermitRefundDto,
  output: PermitRefundDoneDto,
  approval: GatedRefundToolApproval,
  deps: [PermitRefunds],
})
export class GatedRefundTool {
  constructor(private readonly refunds: PermitRefunds) {}

  execute({ orderId }: PermitRefundDto): Promise<PermitRefundDoneDto> {
    this.refunds.refunded.push(orderId);
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

/** The owner confirms a refund himself: no channel serves it. */
@ToolApproval({
  name: "owner-refund-tool-approval",
  description: "The thread's owner approves refunds",
  input: PermitRefundDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(4),
})
export class OwnerRefundToolApproval {}

@Tool({
  name: "owner-refund-tool",
  description: "Refunds an order the owner confirmed",
  input: PermitRefundDto,
  output: PermitRefundDoneDto,
  approval: OwnerRefundToolApproval,
  deps: [PermitRefunds],
})
export class OwnerRefundTool {
  constructor(private readonly refunds: PermitRefunds) {}

  execute({ orderId }: PermitRefundDto): Promise<PermitRefundDoneDto> {
    this.refunds.refunded.push(orderId);
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

@Agent({
  name: "gated-clerk-agent",
  prompt: "./clerk.prompt.md",
  description: "Refunds orders",
  model: "test/clerk",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
  tools: [GatedRefundTool],
})
export class GatedClerkAgent {}

@Agent({
  name: "owner-clerk-agent",
  prompt: "./clerk.prompt.md",
  description: "Refunds orders the owner confirms",
  model: "test/clerk",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
  tools: [OwnerRefundTool],
})
export class OwnerClerkAgent {}

/** The owner answers a spending question; no channel serves it. */
@ExternalTask({
  name: "silent-limit-external-task",
  description: "Asks the thread's owner for a spending limit; nobody is messaged",
  input: PurchaseQuestionDto,
  output: SpendingLimitAnswerDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class SilentLimitExternalTask {}

@WorkflowStart({
  name: "gated-start-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class GatedStart {}

@WorkflowFinish({
  name: "gated-finish-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class GatedFinish {}

@WorkflowStart({
  name: "owner-start-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class OwnerStart {}

@WorkflowFinish({
  name: "owner-finish-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class OwnerFinish {}

@Workflow({
  name: "gated-refund-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(GatedStart).toAgent(GatedClerkAgent).toFinish(GatedFinish)],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  providers: [PermitPolicy, PermitRefunds],
})
export class GatedRefundWorkflow {}

@Workflow({
  name: "owner-refund-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(OwnerStart).toAgent(OwnerClerkAgent).toFinish(OwnerFinish)],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  providers: [PermitRefunds],
})
export class OwnerRefundWorkflow {}

@Workflow({
  name: "silent-purchase-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PurchaseWorkflowStart)
      .toAction(DraftQuestionAction)
      .toExternalTask(SilentLimitExternalTask)
      .toAction(PlacePurchaseAction)
      .toFinish(PurchaseWorkflowFinish),
  ],
  providers: [QuestionInbox],
})
export class SilentPurchaseWorkflow {}

@Application({
  name: "permit-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [GatedRefundWorkflow, OwnerRefundWorkflow, SilentPurchaseWorkflow],
  budgets: TEST_BUDGETS,
  channels: [GatedRefundChannel],
})
export class PermitApplication {}
