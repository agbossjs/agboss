/**
 * PII tokens across a child workflow (#120 S84, #263): the parent's tokens go into the child, the
 * child's come back — with its value, or with its error when it fails. Each side reveals a token only
 * the other side minted: the account of the parent's email tool (a sensitive field), the address the
 * child's notify tool echoes (an email in a tool result).
 */
import {
  Action,
  Agent,
  ChildExecutionFailedError,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type ToolHandler,
} from "../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start, toAgent } from "../helpers/flow.js";
import { ContactPiiPolicy, Outbox, SendEmail } from "./pii.fixture.js";

const price = { inputPerMTok: 1, outputPerMTok: 10 };
const defaults = { models: { temperature: 0 }, tools: { maxToolCalls: 2 } } as const;

export class NotifyRequest {
  @Text({ prompt: "who to notify" })
  to!: string;
}

/** What an agent noted: the value its step puts on the path. */
export class NoteDto {
  @Text({ prompt: "the note" })
  text!: string;
}

/** What the parent's intake noted. */
export class IntakeDto {
  @Text({ prompt: "the intake's note" })
  text!: string;
}

export class NotifyDone {
  @Text({ prompt: "what happened" })
  status!: string;
}

@Tool({
  name: "notify-tool",
  description: "Notifies someone",
  input: NotifyRequest,
  output: NotifyDone,
  deps: [ExecutionContext],
})
export class NotifyTool implements ToolHandler<NotifyRequest, NotifyDone> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run({ to }: NotifyRequest): Promise<NotifyDone> {
    this.executionContext.signal.throwIfAborted();
    return Promise.resolve({ status: `notified ${to}` });
  }
}

/** The parent's first agent: its email tool's account comes back as a token. */
@Agent({
  name: "intake-agent",
  description: "Takes the request",
  prompt: "Take the request.",
  model: "test/intake",
  price,
  tools: [SendEmail],
  output: IntakeDto,
})
export class IntakeAgent {}

/** The child's agent: its notify tool's result carries an address the parent never sees. */
@Agent({
  name: "notifier-agent",
  description: "Notifies",
  prompt: "Notify.",
  model: "test/notifier",
  price,
  tools: [NotifyTool],
  output: NoteDto,
})
export class NotifierAgent {}

/** The parent's agent after the child: it reads the child's answer only. */
@Agent({
  name: "closing-agent",
  description: "Closes the request",
  prompt: "Close the request.",
  model: "test/closing",
  price,
  input: { intake: IntakeDto, answer: NoteDto },
})
export class ClosingAgent {}

/** The parent's agent on the failed child's side path. */
@Agent({
  name: "recovery-agent",
  description: "Says what failed",
  prompt: "Say what failed.",
  model: "test/recovery",
  price,
})
export class RecoveryAgent {}

/** The parent's agent on a failed per-item launch's side path. */
@Agent({
  name: "list-recovery-agent",
  description: "Says what failed",
  prompt: "Say what failed.",
  model: "test/recovery",
  price,
  input: { messages: listOf(WorkflowStartTextDto) },
})
export class ListRecoveryAgent {}

/** The parent's agent after a per-item launch that finished. */
@Agent({
  name: "list-summary-agent",
  description: "Sums the answers up",
  prompt: "Sum up.",
  model: "test/summary",
  price,
  input: { answers: listOf(NoteDto) },
})
export class ListSummaryAgent {}

/** The failing child's last step: it always fails, after the notifier minted its token. */
@Action({
  name: "refuse-action",
  description: "Refuses",
  input: { answer: NoteDto },
})
export class RefuseAction {
  execute(): Promise<void> {
    return Promise.reject(new Error("refused"));
  }
}

@WorkflowStart({
  name: "notify-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class NotifyStart {}

@WorkflowFinish({
  name: "notify-workflow-finish",
  description: "Done",
  output: NoteDto,
})
export class NotifyFinish {}

@Workflow({
  name: "notify-workflow",
  version: "1.0.0",
  flow: [
    start(NotifyStart)
      .returns(WorkflowStartTextDto)
      .toAgent(NotifierAgent)
      .returns(NoteDto)
      .toFinish(NotifyFinish),
  ],
  defaults,
})
export class NotifyWorkflow {}

@WorkflowStart({
  name: "failing-notify-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class FailingNotifyStart {}

@WorkflowFinish({
  name: "failing-notify-workflow-finish",
  description: "Done",
  output: NoteDto,
})
export class FailingNotifyFinish {}

@Workflow({
  name: "failing-notify-workflow",
  version: "1.0.0",
  flow: [
    start(FailingNotifyStart)
      .returns(WorkflowStartTextDto)
      .toAgent(NotifierAgent)
      .returns(NoteDto)
      .toAction(RefuseAction)
      .toFinish(FailingNotifyFinish),
  ],
  defaults,
})
export class FailingNotifyWorkflow {}

@WorkflowStart({
  name: "handover-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class HandoverStart {}

@WorkflowFinish({
  name: "handover-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class HandoverFinish {}

/** parent → child → parent: the intake's tokens into the child, the child's back to the closing. */
@Workflow({
  name: "handover-workflow",
  version: "1.0.0",
  flow: [
    start(HandoverStart)
      .returns(WorkflowStartTextDto)
      .toAgent(IntakeAgent)
      .returns(IntakeDto)
      .toWorkflow(NotifyWorkflow)
      .returns(NoteDto)
      .toAgent(ClosingAgent)
      .toFinish(HandoverFinish),
  ],
  defaults,
  providers: [Outbox],
})
export class HandoverWorkflow {}

@WorkflowStart({
  name: "failed-handover-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class FailedHandoverStart {}

@WorkflowFinish({
  name: "failed-handover-workflow-finish",
  description: "Done",
  output: NoteDto,
})
export class FailedHandoverFinish {}

@WorkflowFinish({
  name: "failed-handover-recovered-workflow-finish",
  description: "What failed",
  output: WorkflowFinishTextDto,
})
export class FailedHandoverRecoveredFinish {}

/** A failed child: its tokens come back with its error, to the side path that takes it. */
@Workflow({
  name: "failed-handover-workflow",
  version: "1.0.0",
  flow: [
    start(FailedHandoverStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(FailingNotifyWorkflow)
      .onError(
        ChildExecutionFailedError,
        toAgent(RecoveryAgent).toFinish(FailedHandoverRecoveredFinish),
      )
      .returns(NoteDto)
      .toFinish(FailedHandoverFinish),
  ],
  defaults,
})
export class FailedHandoverWorkflow {}

@WorkflowStart({
  name: "failed-list-workflow-start",
  description: "Requests",
  input: listOf(WorkflowStartTextDto),
})
export class FailedListStart {}

@WorkflowFinish({
  name: "failed-list-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class FailedListFinish {}

@WorkflowFinish({
  name: "failed-list-recovered-workflow-finish",
  description: "What failed",
  output: WorkflowFinishTextDto,
})
export class FailedListRecoveredFinish {}

/** A failed per-item child: its tokens come back with the branch's error, to the join's side path. */
@Workflow({
  name: "failed-list-workflow",
  version: "1.0.0",
  flow: [
    start(FailedListStart)
      .returns(listOf(WorkflowStartTextDto))
      .toParallelWorkflows(FailingNotifyWorkflow, { maxConcurrency: 1, maxItems: 1 })
      .join()
      .onJoinError(
        ChildExecutionFailedError,
        toAgent(ListRecoveryAgent).toFinish(FailedListRecoveredFinish),
      )
      .returns(listOf(NoteDto))
      .toAgent(ListSummaryAgent)
      .toFinish(FailedListFinish),
  ],
  defaults,
  maxSteps: 4,
})
export class FailedListWorkflow {}

@Application({
  name: "handover-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HandoverWorkflow, FailedHandoverWorkflow, FailedListWorkflow],
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
})
export class HandoverApplication {}
