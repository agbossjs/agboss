import { Window2Memory } from "../helpers/window-memory.js";
import {
  Agent,
  Channel,
  ChannelOutcome,
  ExecutionContext,
  Injectable,
  InjectionToken,
  PauseRespondent,
  Workflow,
  type ChannelAsk,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
  Tool,
  ToolApproval,
  Ttl,
} from "../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { onStart } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { days } from "../../src/units/index.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

/** One ask a channel posted: the pause's id and the question (the tool call, read by the tests). */
export interface PostedAsk {
  readonly pauseId: string;
  readonly input: unknown;
  readonly toolCall?: unknown;
}

/** What the channels posted and what the tools did — the observable effects the tests read. */
@Injectable()
export class ApprovalDesk {
  readonly posted: PostedAsk[] = [];
  readonly refunded: string[] = [];
  /** The tenant each ask was made for, read from the injected `ExecutionContext` (#261). */
  readonly tenants: string[] = [];
}

/** A concrete chat-app channel a tool names as is: posts the ask (here: to the desk). */
/** What ChatAppChannel asks for: the approval of the tools that name it. */
@ToolApproval({
  name: "chat-app-tool-approval",
  description: "Approval of the tools asked through ChatAppChannel",
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class ChatAppToolApproval {}

@Channel({
  name: "chat-app-channel",
  deps: [ApprovalDesk, ExecutionContext],
  target: ChatAppToolApproval,
  ttl: days(1),
})
export class ChatAppChannel {
  constructor(
    private readonly desk: ApprovalDesk,
    private readonly executionContext: ExecutionContext,
  ) {}

  send(ask: ChannelAsk<ChatAppToolApproval>): Promise<ChannelOutcome<ChatAppToolApproval>> {
    this.desk.posted.push(ask);
    this.desk.tenants.push(this.executionContext.tenant.tenantId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

export class RefundRequest {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

class RefundDone {
  @Text()
  status!: string;
}

/** The refund approval role (#267): the tool names it, the application provides its implementation. */
@ToolApproval({
  name: "refund-desk-tool-approval",
  description: "Approves refunds",
  input: RefundRequest,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class RefundDeskToolApproval {}

/** The role's implementation: posts the ask to the desk and waits for the reply. */
@Channel({
  name: "desk-refund-approval-channel",
  deps: [ApprovalDesk, ExecutionContext],
  target: RefundDeskToolApproval,
  ttl: days(1),
})
export class DeskRefundApprovalChannel {
  constructor(
    private readonly desk: ApprovalDesk,
    private readonly executionContext: ExecutionContext,
  ) {}

  send(ask: ChannelAsk<RefundDeskToolApproval>): Promise<ChannelOutcome<RefundDeskToolApproval>> {
    this.desk.posted.push(ask);
    this.desk.tenants.push(this.executionContext.tenant.tenantId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  input: RefundRequest,
  output: RefundDone,
  approval: RefundDeskToolApproval,
  deps: [ApprovalDesk],
})
export class Refund {
  constructor(private readonly desk: ApprovalDesk) {}

  execute({ orderId }: RefundRequest): Promise<RefundDone> {
    this.desk.refunded.push(orderId);
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

@Agent({
  name: "clerk-agent",
  prompt: "./clerk.prompt.md",
  description: "Refunds orders",
  model: "test/clerk",
  tools: [Refund],
})
export class Clerk {}

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class ChatStart {}

@WorkflowFinish({
  name: "reply-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class Reply {}

const defaults = {
  models: { temperature: 0, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 2 },
} as const;

class NoLimits implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .build();
  }
}

/** One agent whose refund tool waits for an approval through the refund approval role. */
@Workflow({
  name: "refunds-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart)
    .toAgent(Clerk)
    .toFinish(Reply)],
  defaults,
  memory: Window2Memory,
  providers: [ApprovalDesk],
})
export class Refunds extends NoLimits {}

@Application({
  name: "refunds-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [Refunds],
  budgets: TEST_BUDGETS,
  providers: [DeskRefundApprovalChannel],
})
export class RefundsApplication {}

export const AUDIT_LOG = new InjectionToken<string[]>("AUDIT_LOG");

/** An implementation of the role whose dependency nobody provides. */
@Channel({
  name: "audited-refund-approval-channel",
  deps: [AUDIT_LOG],
  target: RefundDeskToolApproval,
  ttl: days(1),
})
export class AuditedRefundApprovalChannel {
  constructor(private readonly log: string[]) {}

  send(ask: ChannelAsk<RefundDeskToolApproval>): Promise<ChannelOutcome<RefundDeskToolApproval>> {
    this.log.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Application({
  name: "audited-refunds-application",
  version: "1.0.0",
  workflows: [Refunds],
  budgets: TEST_BUDGETS,
  providers: [AuditedRefundApprovalChannel],
})
export class AuditedRefundsApplication {}
