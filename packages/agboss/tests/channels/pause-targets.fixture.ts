import {
  Agent,
  Channel,
  ChannelInterpretation,
  ChannelInterpreter,
  ChannelListener,
  ChannelOutcome,
  ChannelSelector,
  ExecutionContext,
  ExternalTask,
  Injectable,
  PauseRespondent,
  Tool,
  ToolApproval,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ChannelListenerClosedEvent,
  type ChannelListenerOpenedEvent,
  Ttl,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { days, hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import {
  DraftQuestionAction,
  PlacePurchaseAction,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  SpendingLimitAnswerDto,
} from "../flow/fixtures/questions.fixture.js";
import { QuestionInbox } from "../flow/fixtures/questions.fixture.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

/**
 * #1307a / #1310c: the pause targets in their new form — `@ExternalTask` and `@ToolApproval` bound to
 * their transports by `@Channel({ target })`, a `@ChannelInterpreter` with no `decidedBy` and no
 * `implements`, a `@ChannelListener` with one hook, the flat `@Application` shelves. The runtime is
 * the one the old form runs on (the cases of question-step / approval-channels, ported).
 */

/** What the new-form channels were asked, across the instances of a test. */
@Injectable()
export class TargetInbox {
  readonly asked: ChannelAsk<unknown>[] = [];
  readonly approvals: ChannelAsk<unknown>[] = [];
  readonly refunded: string[] = [];
}

/** Reads "up to 500" / "no": a code interpreter with no `decidedBy` and no `implements`. */
@ChannelInterpreter()
export class LimitChannelInterpreter {
  interpret(input: { readonly reply: string }): ChannelInterpretation<unknown> {
    const limit = /up to \$?(\d+)/.exec(input.reply);
    if (limit?.[1] !== undefined)
      return ChannelInterpretation.understood({ approved: true, limitUsd: Number(limit[1]) });
    if (/^no\b/i.test(input.reply.trim()))
      return ChannelInterpretation.understood({ approved: false, limitUsd: 0 });
    return ChannelInterpretation.notUnderstood(`"${input.reply}" names no limit`);
  }
}

@ExternalTask({
  name: "spending-limit-external-task",
  description: "Asks the thread's owner for this purchase's spending limit",
  input: PurchaseQuestionDto,
  output: SpendingLimitAnswerDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
  channelInterpreter: LimitChannelInterpreter,
})
export class SpendingLimitExternalTask {}

/** The owner's inbox: serves the task by its `target`, no `extends`. */
@Channel({
  name: "inbox-spending-limit-channel",
  description: "The owner's inbox",
  target: SpendingLimitExternalTask,
  ttl: days(14),
  deps: [ExecutionContext, TargetInbox],
})
export class InboxSpendingLimitChannel {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly inbox: TargetInbox,
  ) {}

  send(ask: ChannelAsk<SpendingLimitExternalTask>): ChannelOutcome<SpendingLimitExternalTask> {
    this.executionContext.signal.throwIfAborted();
    this.inbox.asked.push(ask);
    return ChannelOutcome.awaitReply();
  }
}

export class RefundRequestDto {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class RefundDoneDto {
  @Text()
  status!: string;
}

/** An approval with no `input`: it approves any tool that names it. */
@ToolApproval({
  name: "any-tool-approval",
  description: "Approves any tool call",
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
})
export class AnyToolApproval {}

@ToolApproval({
  name: "refund-tool-approval",
  description: "Approves refunds",
  input: RefundRequestDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
  remindBefore: hours(1),
})
export class RefundToolApproval {}

@Channel({
  name: "desk-refund-channel",
  description: "The desk",
  target: RefundToolApproval,
  ttl: days(7),
  deps: [TargetInbox],
})
export class DeskRefundChannel {
  constructor(private readonly inbox: TargetInbox) {}

  send(ask: ChannelAsk<RefundToolApproval>): Promise<ChannelOutcome<RefundToolApproval>> {
    this.inbox.approvals.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "refund-tool",
  description: "Refunds an order",
  input: RefundRequestDto,
  output: RefundDoneDto,
  approval: RefundToolApproval,
  deps: [TargetInbox],
})
export class RefundTool {
  constructor(private readonly inbox: TargetInbox) {}

  execute({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    this.inbox.refunded.push(orderId);
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

@Agent({
  name: "clerk-agent",
  prompt: "./clerk.prompt.md",
  description: "Refunds orders",
  model: "test/clerk",
  tools: [RefundTool],
})
export class ClerkAgent {}

@WorkflowStart({
  name: "refund-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class RefundWorkflowStart {}

@WorkflowFinish({
  name: "refund-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class RefundWorkflowFinish {}

/** A listener of one hook: no `implements`, no stub for the other. */
@ChannelListener()
export class OpenedOnlyChannelListener {
  readonly opened: ChannelListenerOpenedEvent[] = [];

  onPauseOpened(event: ChannelListenerOpenedEvent): void {
    this.opened.push(event);
  }
}

/** A listener of the closing alone. */
@ChannelListener({ name: "closed-only-listener" })
export class ClosedOnlyChannelListener {
  readonly closed: ChannelListenerClosedEvent[] = [];

  onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    this.closed.push(event);
    return Promise.resolve();
  }
}

/** Never picks: the rules and the types only. */
@ChannelSelector({ target: RefundToolApproval })
export class RefundChannelSelector {
  selectChannel(): typeof DeskRefundChannel {
    return DeskRefundChannel;
  }
}

@Workflow({
  name: "purchase-targets-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PurchaseWorkflowStart)
      .toAction(DraftQuestionAction)
      .toExternalTask(SpendingLimitExternalTask)
      .toAction(PlacePurchaseAction)
      .toFinish(PurchaseWorkflowFinish),
  ],
  providers: [QuestionInbox, TargetInbox],
})
export class PurchaseTargetsWorkflow {}

@Workflow({
  name: "refund-targets-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(RefundWorkflowStart).toAgent(ClerkAgent).toFinish(RefundWorkflowFinish)],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  providers: [TargetInbox],
})
export class RefundTargetsWorkflow {}

@Application({
  name: "targets-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PurchaseTargetsWorkflow, RefundTargetsWorkflow],
  budgets: TEST_BUDGETS,
  channels: [InboxSpendingLimitChannel, DeskRefundChannel],
  channelListeners: [OpenedOnlyChannelListener, ClosedOnlyChannelListener],
})
export class TargetsApplication {}

export { PurchasePlacedDto };
