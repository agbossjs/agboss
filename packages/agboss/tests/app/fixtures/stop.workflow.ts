import { hours, Ttl } from "../../../src/units/index.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  Observer,
  type InterruptCleanupErrorEvent,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../../src/index.js";
import { onStart } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/** What the stop fixture saw: the payments made, and the gate a test opens. */
export const stopSeen: {
  payments: string[];
  /** The execution the gate step ran in. */
  executionId?: string;
  /** Resolves with the thread when the gate step began. */
  started?: (thread: string) => void;
  /** Opens the gate: the step in flight returns. */
  open?: () => void;
  /** The `onInterrupted` cleanups that ran, in order, with the reason each was told. */
  cleanups: string[];
  /** The failures of cleanups the observer was told of. */
  cleanupErrors: {
    readonly reason: string;
    readonly message: string;
    readonly component: string;
  }[];
} = { payments: [], cleanups: [], cleanupErrors: [] };

export class NoteDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

/** A step that waits at a gate a test opens — and, when asked, for its execution's abort. */
@Tool({
  name: "gate-tool",
  description: "Waits at a gate",
  input: NoteDto,
  output: NoteDto,
  deps: [ExecutionContext],
})
export class Gate {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: NoteDto): Promise<NoteDto> {
    const { signal, threadId, executionId } = this.executionContext;
    stopSeen.executionId = executionId;
    // three cleanups: the last registered runs first; the middle one fails and the rest still run
    this.executionContext.onInterrupted((reason) => {
      stopSeen.cleanups.push(`first:${reason}`);
    });
    this.executionContext.onInterrupted((reason) => {
      stopSeen.cleanups.push(`second:${reason}`);
      throw new Error("the cleanup failed");
    });
    this.executionContext.onInterrupted(async (reason) => {
      await Promise.resolve();
      stopSeen.cleanups.push(`third:${reason}:${this.executionContext.executionId}`);
    });
    stopSeen.started?.(threadId);
    return new Promise((resolve) => {
      stopSeen.open = () => {
        resolve(input);
      };
      signal.addEventListener("abort", () => {
        resolve(input);
      });
    });
  }
}

/** Reports the cleanups that failed. */
@Observer({ name: "gate-observer" })
export class GateObserver {
  onInterruptCleanupError(event: InterruptCleanupErrorEvent): void {
    stopSeen.cleanupErrors.push({
      reason: event.reason,
      message: event.error instanceof Error ? event.error.message : "",
      component: event.component.name,
    });
  }
}

@Agent({
  name: "gate-agent",
  description: "Goes through the gate",
  prompt: inline("Go through the gate."),
  tools: [Gate],
  model: "test/gate",
  input: { message: WorkflowStartTextDto },
  output: NoteDto,
})
export class GateAgent {}

/** The effect the stop must not run after it. */
@Action({ name: "settle-action", description: "Settles", deps: [ExecutionContext] })
export class Settle {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<void> {
    stopSeen.payments.push(this.executionContext.executionId);
    return Promise.resolve();
  }
}

@WorkflowStart({
  name: "gate-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class GateStart {}

@WorkflowFinish({ name: "gate-workflow-finish", description: "The note", output: NoteDto })
export class GateFinish {}

/** The agent, then the settlement. */
@Workflow({
  name: "gate-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: { models: { maxTokens: 100, temperature: 0 }, tools: { maxToolCalls: 3 } },
  providers: [Settle],
  flow: [onStart(GateStart)
    .toAgent(GateAgent)
    .toAction(Settle)
    .toFinish(GateFinish)],
})
export class GateWorkflow {}

/** Keeps its execution history, so a test reads the thread's status history after the end. */
@Application({
  name: "gate-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [GateWorkflow],
  observers: [GateObserver],
  budgets: TEST_BUDGETS,
  retention: { executionRecords: hours(24) },
})
export class GateApplication {}
