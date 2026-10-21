import {
  Agent,
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  ExecutionContext,
  Injectable,
  InjectionToken,
  PauseAnswerer,
  Workflow,
  type ChannelAsk,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
  Tool,
  type ToolHandler,
} from "../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { start } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

/** One ask a channel posted: the pause's id and the question (the tool call, read by the tests). */
export interface PostedAsk {
  readonly pauseId: string;
  readonly value: unknown;
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
@Channel({ name: "chat-app-channel", deps: [ApprovalDesk, ExecutionContext] })
export class ChatAppChannel {
  constructor(
    private readonly desk: ApprovalDesk,
    private readonly executionContext: ExecutionContext,
  ) {}

  send(ask: ChannelAsk<ChatAppChannel>): Promise<ChannelOutcome<ChatAppChannel>> {
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
@ChannelRole({
  name: "refund-approval-channel",
  description: "Approves refunds",
  approves: RefundRequest,
  answeredBy: PauseAnswerer.Channel,
})
export abstract class RefundApprovalChannel extends ChannelOf<RefundApprovalChannel> {}

/** The role's implementation: posts the ask to the desk and waits for the reply. */
@Channel({ name: "desk-refund-approval-channel", deps: [ApprovalDesk, ExecutionContext] })
export class DeskRefundApprovalChannel extends RefundApprovalChannel {
  constructor(
    private readonly desk: ApprovalDesk,
    private readonly executionContext: ExecutionContext,
  ) {
    super();
  }

  send(ask: ChannelAsk<RefundApprovalChannel>): Promise<ChannelOutcome<RefundApprovalChannel>> {
    this.desk.posted.push(ask);
    this.desk.tenants.push(this.executionContext.tenant.tenantId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "refund",
  description: "Refunds an order",
  input: RefundRequest,
  output: RefundDone,
  channel: RefundApprovalChannel,
  deps: [ApprovalDesk],
})
export class Refund implements ToolHandler<RefundRequest, RefundDone> {
  constructor(private readonly desk: ApprovalDesk) {}

  run({ orderId }: RefundRequest): Promise<RefundDone> {
    this.desk.refunded.push(orderId);
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

@Agent({
  name: "clerk-agent",
  promptUrls: ["./clerk.prompt.md"],
  description: "Refunds orders",
  model: "test/clerk",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
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
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .toFinish(Reply),
  ],
  defaults,
  uncompactedTurns: 2,
  providers: [ApprovalDesk],
})
export class Refunds extends NoLimits {}

@Application({
  name: "refunds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Refunds],
  budgets: TEST_BUDGETS,
  providers: [DeskRefundApprovalChannel],
})
export class RefundsApplication {}

export const AUDIT_LOG = new InjectionToken<string[]>("AUDIT_LOG");

/** An implementation of the role whose dependency nobody provides. */
@Channel({ name: "audited-refund-approval-channel", deps: [AUDIT_LOG] })
export class AuditedRefundApprovalChannel extends RefundApprovalChannel {
  constructor(private readonly log: string[]) {
    super();
  }

  send(ask: ChannelAsk<RefundApprovalChannel>): Promise<ChannelOutcome<RefundApprovalChannel>> {
    this.log.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Application({
  name: "audited-refunds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Refunds],
  budgets: TEST_BUDGETS,
  providers: [AuditedRefundApprovalChannel],
})
export class AuditedRefundsApplication {}
