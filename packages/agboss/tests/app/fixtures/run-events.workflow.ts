import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionStartEvent,
  type AgentStartEvent,
  type ChannelEndEvent,
  type ChannelStartEvent,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionEvent,
  type ExecutionPauseEvent,
  type ExecutionRejectedEvent,
  type ExecutionResumeEvent,
  type ExecutionStartEvent,
  type ModelStartEvent,
  type NodeEvent,
  type OnActionStart,
  type OnAgentStart,
  type OnChannelEnd,
  type OnChannelStart,
  type OnExecutionEnd,
  type OnExecutionError,
  type OnExecutionPause,
  type OnExecutionRejected,
  type OnExecutionResume,
  type OnExecutionStart,
  type OnModelStart,
  type OnToolStart,
  type ToolHandler,
  type ToolStartEvent,
} from "../../../src/index.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

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
@Tool({ name: "lookup", description: "Looks jobs up", input: Query, output: Query })
export class Lookup implements ToolHandler<Query, Query> {
  run(input: Query): Promise<Query> {
    return Promise.resolve(input);
  }
}

/** A write tool with an approval channel: a run pauses before it. */
@Tool({
  name: "apply",
  description: "Applies for a job",
  channel: TerminalUserChannel,
  input: Query,
  output: Query,
})
export class Apply implements ToolHandler<Query, Query> {
  run(input: Query): Promise<Query> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "clerk-agent",
  description: "Applies for jobs",
  prompt: "Apply for the jobs asked for.",
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
@Injectable()
export class RunLog
  implements
    OnExecutionStart,
    OnExecutionPause,
    OnExecutionResume,
    OnExecutionEnd,
    OnExecutionError,
    OnExecutionRejected,
    OnAgentStart,
    OnModelStart,
    OnToolStart,
    OnChannelStart,
    OnChannelEnd,
    OnActionStart
{
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
    this.pushExecution("execution-pause", event, event.pause);
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
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    history: { limit: 1 },
    tools: { maxToolCalls: 3 },
  },
  providers: [FileAway],
  channelClasses: [TerminalUserChannel],
  flow: [
    start(Ask)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .returns(AnswerDto)
      .toAction(FileAway)
      .toFinish(Done),
  ],
})
export class Applications {}

@Application({
  name: "applications-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Applications],
  budgets: TEST_BUDGETS,
  observers: [RunLog],
})
export class ApplicationsApplication {}
