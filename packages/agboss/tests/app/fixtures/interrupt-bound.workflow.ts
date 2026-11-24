import { hours, seconds } from "../../../src/units/index.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  Observer,
  type InterruptCleanupErrorEvent,
  EmptyEnvironment,
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

/** What the bound fixture saw. */
export const boundSeen: {
  started?: (thread: string) => void;
  cleanups: string[];
  errors: string[];
} = { cleanups: [], errors: [] };

export class BoundNoteDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

/** A step whose newest cleanup never returns: the older one waits behind it, past the bound. */
@Tool({
  name: "hang-tool",
  description: "Waits for an abort",
  input: BoundNoteDto,
  output: BoundNoteDto,
  deps: [ExecutionContext],
})
export class Hang {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: BoundNoteDto): Promise<BoundNoteDto> {
    const { signal, threadId } = this.executionContext;
    this.executionContext.onInterrupted((reason) => {
      boundSeen.cleanups.push(`older:${reason}`);
    });
    this.executionContext.onInterrupted(async () => {
      boundSeen.cleanups.push("newest:begun");
      await new Promise<never>(() => undefined);
    });
    boundSeen.started?.(threadId);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(input);
      });
    });
  }
}

@Observer({ name: "bound-observer" })
export class BoundObserver {
  onInterruptCleanupError(event: InterruptCleanupErrorEvent): void {
    boundSeen.errors.push(
      `${event.reason}:${event.error instanceof Error ? event.error.message : ""}`,
    );
  }
}

@Agent({
  name: "bound-agent",
  description: "Goes to the hanging step",
  prompt: inline("Go."),
  tools: [Hang],
  model: "test/bound",
  input: { message: WorkflowStartTextDto },
  output: BoundNoteDto,
})
export class BoundAgent {}

@WorkflowStart({
  name: "bound-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class BoundStart {}

@WorkflowFinish({ name: "bound-workflow-finish", description: "The note", output: BoundNoteDto })
export class BoundFinish {}

@Workflow({
  name: "bound-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 }, tools: { maxToolCalls: 3 } },
  flow: [onStart(BoundStart).toAgent(BoundAgent).toFinish(BoundFinish)],
})
export class BoundWorkflow {}

/** The cleanups of an interrupted step are bounded by `executionLimits.shutdownTimeout` (5 s). */
@Application({
  name: "bound-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BoundWorkflow],
  observers: [BoundObserver],
  budgets: TEST_BUDGETS,
  executionLimits: { shutdownTimeout: seconds(5) },
  retention: { executionRecords: hours(24) },
})
export class BoundApplication {}
