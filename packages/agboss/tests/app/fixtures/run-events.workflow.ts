import { Window1Memory } from "../../helpers/window-memory.js";
import { OwnerToolApproval } from "../../flow/fixtures/owner-approval.fixture.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  Observer,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionStartEvent,
  type AgentStartEvent,
  type ChannelEndEvent,
  type ChannelStartEvent,
  type ExecutionEndEvent,
  type ExecutionCancelEvent,
  type ExecutionErrorEvent,
  type ExecutionEvent,
  type ExecutionPauseEvent,
  type ExecutionRejectedEvent,
  type ExecutionResumeEvent,
  type ExecutionStartEvent,
  type ModelStartEvent,
  type NodeEvent,
  type ToolStartEvent,
  inline,
  Ttl,
} from "../../../src/index.js";
import { onStart } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/** One observer event: the hook, the run and thread it carried, and what else the test checks. */
export interface SeenEvent {
  readonly hook: string;
  readonly runId: string;
  readonly threadId: string | undefined;
  readonly detail?: unknown;
}

/** Every event the observer saw, in order (reset with `resetEvents`). */
export const events: SeenEvent[] = [];

/** Every request the app refused before an execution (`onExecutionRejected`), in order. */
export const rejections: ExecutionRejectedEvent[] = [];

/** Every execution-level event as the observer got it (its common fields checked by tests). */
export const executionEvents: ExecutionEvent[] = [];

/** Every node event as the observer got it (`step` checked by tests). */
export const nodeEvents: NodeEvent[] = [];

export function resetEvents(): void {
  events.length = 0;
  rejections.length = 0;
  executionEvents.length = 0;
  nodeEvents.length = 0;
}

/** The execution-level events only (`execution-start`, `execution-pause`, …, `execution-error`). */
export const workflowEvents = (): SeenEvent[] =>
  events.filter((event) => event.hook.startsWith("execution-"));

/** The clerk's answer, kept by the finish. */
export class AnswerDto {
  @Text({ prompt: "the answer" })
  text!: string;
}

export class Query {
  @Text({ prompt: "what to look up" })
  text!: string;
}

/** A read tool. */
@Tool({ name: "lookup-tool", description: "Looks jobs up", input: Query, output: Query })
export class Lookup {
  execute(input: Query): Promise<Query> {
    return Promise.resolve(input);
  }
}

/** A write tool with an approval channel: a run pauses before it. */
@Tool({
  name: "apply-tool",
  description: "Applies for a job",
  approval: OwnerToolApproval,
  input: Query,
  output: Query,
})
export class Apply {
  execute(input: Query): Promise<Query> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "clerk-agent",
  description: "Applies for jobs",
  prompt: inline("Apply for the jobs asked for."),
  tools: [Lookup, Apply],
  model: "test/clerk",
  input: { message: WorkflowStartTextDto },
  output: AnswerDto,
})
export class Clerk {}

@Action({ name: "file-action", description: "Files the applications" })
export class FileAway {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

/** Records every execution-level event and the node events, each with its execution and thread. */
@Observer()
export class RunLog {
  private push(hook: string, event: ExecutionEvent, detail?: unknown): void {
    events.push({ hook, runId: event.executionId, threadId: event.threadId, detail });
  }
  private pushNode(hook: string, event: NodeEvent): void {
    nodeEvents.push(event);
    this.push(hook, event);
  }
  private pushExecution(hook: string, event: ExecutionEvent, detail?: unknown): void {
    executionEvents.push(event);
    this.push(hook, event, detail);
  }
  onExecutionStart(event: ExecutionStartEvent): void {
    this.pushExecution("execution-start", event);
  }
  onExecutionPause(event: ExecutionPauseEvent): void {
    this.pushExecution("execution-pause", event, event.pending);
  }
  onExecutionResume(event: ExecutionResumeEvent): void {
    this.pushExecution("execution-resume", event, event.decision);
  }
  onExecutionEnd(event: ExecutionEndEvent): void {
    this.pushExecution("execution-end", event, event.finish);
  }
  onExecutionError(event: ExecutionErrorEvent): void {
    this.pushExecution("execution-error", event, event.error);
  }
  onExecutionCancel(event: ExecutionCancelEvent): void {
    this.pushExecution("execution-cancel", event, event.compensations);
  }
  onExecutionRejected(event: ExecutionRejectedEvent): void {
    rejections.push(event);
  }
  onAgentStart(event: AgentStartEvent): void {
    this.pushNode("agent-start", event);
  }
  onModelStart(event: ModelStartEvent): void {
    this.pushNode("model-start", event);
  }
  onToolStart(event: ToolStartEvent): void {
    this.pushNode("tool-start", event);
  }
  onChannelStart(event: ChannelStartEvent): void {
    this.pushNode("channel-start", event);
  }
  onChannelEnd(event: ChannelEndEvent): void {
    this.pushNode("channel-end", event);
  }
  onActionStart(event: ActionStartEvent): void {
    this.pushNode("action-start", event);
  }
}

@WorkflowStart({
  name: "ask-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class Ask {}

@WorkflowFinish({ name: "done-workflow-finish", description: "The answer", output: AnswerDto })
export class Done {}

/** ask → clerk → file → done, observed by `RunLog`. */
@Workflow({
  name: "applications-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    tools: { maxToolCalls: 3 },
  },
  memory: Window1Memory,
  providers: [FileAway],
  flow: [onStart(Ask).toAgent(Clerk).toAction(FileAway).toFinish(Done)],
})
export class Applications {}

@Application({
  name: "applications-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Applications],
  budgets: TEST_BUDGETS,
  observers: [RunLog],
})
export class ApplicationsApplication {}
