import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  ApplicationContext,
  Clock,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionLease,
  type OnDestroy,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import type { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";

/**
 * #367 — a step whose body ignores its signal: the first run of the slow action (and of the slow
 * tool) waits until the test lets it go, whatever its execution's signal says; later runs return
 * at once. The application's teardown, its lease releases and the bodies write one ordered log, so
 * a test sees whether `onDestroy` or a release came before a body returned.
 */

/** What happened, in order (reset with `resetCloseSteps`). */
export const order: string[] = [];

/** The test's levers: the first body's start and its release. */
export const bodies: { started?: () => void; letGo?: () => void; runs: number } = { runs: 0 };

export function resetCloseSteps(): void {
  order.length = 0;
  bodies.runs = 0;
  delete bodies.started;
  delete bodies.letGo;
}

/** Until the first body started (the test's `await`). */
export const firstBodyStarted = (): Promise<void> =>
  new Promise((resolve) => {
    bodies.started = resolve;
  });

/** One body: the first waits for the test, ignoring `signal`; later ones return at once. */
async function slowBody(what: string, signal: AbortSignal): Promise<void> {
  bodies.runs += 1;
  const run = bodies.runs;
  order.push(`${what} ${String(run)} started`);
  if (run === 1) {
    signal.addEventListener("abort", () => order.push(`${what} ${String(run)} sees the abort`));
    await new Promise<void>((resolve) => {
      bodies.letGo = resolve;
      bodies.started?.();
    });
  }
  order.push(`${what} ${String(run)} returned`);
}

/** A service the application tears down: its `onDestroy` is logged. */
@Injectable()
export class Teardown implements OnDestroy {
  onDestroy(): void {
    order.push("onDestroy");
  }
}

/** The leases in the test's memory; each release is logged. */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class LoggedExecutionLeaseRepository extends InMemoryExecutionLeaseRepository {
  override async release(lease: ExecutionLease): Promise<void> {
    order.push(`lease released by ${lease.holderInstanceId}`);
    await super.release(lease);
  }
}

export class ReceiptDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

@Action({
  name: "slow-action",
  description: "Works until the test lets it go, ignoring its signal",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
  deps: [ExecutionContext, Teardown],
})
export class SlowAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    readonly teardown: Teardown,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ReceiptDto> {
    await slowBody("action", this.executionContext.signal);
    return { text: `done: ${input.message.value.text}` };
  }
}

export class Query {
  @Text({ prompt: "what to do" })
  text!: string;
}

@Tool({
  name: "slow-tool",
  description: "Works until the test lets it go, ignoring its signal",
  input: Query,
  output: Query,
  timeout: seconds(600),
  deps: [ExecutionContext, Teardown],
})
export class SlowTool implements ToolHandler<Query, Query> {
  constructor(
    private readonly executionContext: ExecutionContext,
    readonly teardown: Teardown,
  ) {}

  async run(input: Query): Promise<Query> {
    await slowBody("tool", this.executionContext.signal);
    return input;
  }
}

@Agent({
  name: "worker-agent",
  description: "Calls the slow tool",
  prompt: "Do what you are asked.",
  tools: [SlowTool],
  model: "test/worker",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
})
export class WorkerAgent {}

@WorkflowStart({
  name: "slow-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class SlowWorkflowStart {}

@WorkflowStart({
  name: "tool-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class ToolWorkflowStart {}

@WorkflowFinish({ name: "slow-workflow-finish", description: "The receipt", output: ReceiptDto })
export class SlowWorkflowFinish {}

@WorkflowFinish({ name: "tool-workflow-finish", description: "The receipt", output: ReceiptDto })
export class ToolWorkflowFinish {}

@Workflow({
  name: "slow-workflow",
  version: "1.0.0",
  flow: [
    start(SlowWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(SlowAction)
      .returns(ReceiptDto)
      .toFinish(SlowWorkflowFinish),
  ],
  providers: [Teardown],
})
export class SlowWorkflow {}

@Workflow({
  name: "tool-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 } },
  flow: [
    start(ToolWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(WorkerAgent)
      .returns(ReceiptDto)
      .toFinish(ToolWorkflowFinish),
  ],
  providers: [Teardown],
})
export class ToolWorkflow {}

/** A minute to stop: interrupted at 55 s, its bodies awaited in the 5 s grace (#367 S3). */
@Application({
  name: "close-steps-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SlowWorkflow, ToolWorkflow],
  observers: [RecoveryLog],
  providers: [LoggedExecutionLeaseRepository, StampedExecutionRecordRepository, RecordingLogger],
  budgets: TEST_BUDGETS,
  shutdownTimeout: seconds(60),
})
export class CloseStepsApplication {}
