import {
  Action,
  Agent,
  Budget,
  BudgetExceededError,
  BudgetPeriod,
  BudgetScope,
  EmptyEnvironment,
  ExecutionContext,
  listOf,
  SpendRecorder,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Injectable } from "../../../src/components/decorators.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { usd, type Usd } from "../../../src/units/index.js";
import {
  TestApplicationDailyBudget,
  TestExecutionBudget,
  TestTenantDailyBudget,
} from "../../flow/fixtures/budgets.js";
import { start, toAction, toFinish } from "../../helpers/flow.js";

/**
 * #338 — a budget crossed inside a parallel launch. Two branches: the spender waits until the
 * waiter's tool runs (`hold-for-waiter-tool`), then answers with a costly call; the waiter's tool pays a
 * service and waits on its call's `executionContext.signal` until it is aborted. The same pair as
 * agents (`toParallelAgents`, with and without `.onJoinError`, and under a quorum) and as per-item
 * child workflows (`toParallelWorkflows`); one application per budget that is tight.
 */

/** What ran: the tools' events in order, why the waiter's signal aborted. */
export const parallelBudgetLog = {
  events: [] as string[],
  aborts: [] as string[],
};

/** The ledgers of the applications started, for a test to read their counters. */
export const parallelLedgers: ParallelCostLedgerRepository[] = [];

/** The waiter's tool is running: the spender goes on. */
let waiterRunning: () => void = () => undefined;
let isWaiterRunning: Promise<void> = Promise.resolve();

export function resetParallelBudget(): void {
  parallelBudgetLog.events.length = 0;
  parallelBudgetLog.aborts.length = 0;
  parallelLedgers.length = 0;
  isWaiterRunning = new Promise<void>((resolve) => {
    waiterRunning = resolve;
  });
}

/** The in-memory ledger, listed so the test sees the instance the budgets count in. */
@Injectable()
export class ParallelCostLedgerRepository extends InMemoryCostLedgerRepository {
  constructor() {
    super();
    parallelLedgers.push(this);
  }
}

export class HoldDto {
  @Text({ prompt: "what the tool is for" })
  reason!: string;
}

export class NoteDto {
  @Text({ prompt: "the note" })
  text!: string;
}

export class TaskDto {
  @Text({ prompt: "the task's name" })
  name!: string;
}

/** Waits until the waiter's tool runs: the spender's costly call comes while the waiter waits. */
@Tool({
  name: "hold-for-waiter-tool",
  description: "Waits for the other branch",
  input: HoldDto,
  output: HoldDto,
})
export class HoldForWaiterTool implements ToolHandler<HoldDto, HoldDto> {
  async run(input: HoldDto): Promise<HoldDto> {
    await isWaiterRunning;
    parallelBudgetLog.events.push("spender goes on");
    return input;
  }
}

/** Pays a service 0.03 USD, then waits on its call's signal like a slow fetch, until aborted. */
@Tool({
  name: "wait-for-abort-tool",
  description: "Waits until stopped",
  input: HoldDto,
  output: HoldDto,
  deps: [ExecutionContext, SpendRecorder],
})
export class WaitForAbortTool implements ToolHandler<HoldDto, HoldDto> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  run(): Promise<HoldDto> {
    const { signal } = this.executionContext;
    this.spendRecorder.record({ service: "slow-api", cost: usd(0.03) });
    parallelBudgetLog.events.push("waiter waits");
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const reason: unknown = signal.reason;
        parallelBudgetLog.aborts.push(reason instanceof Error ? reason.name : String(reason));
        parallelBudgetLog.events.push("waiter aborted");
        reject(reason instanceof Error ? reason : new Error("aborted"));
      });
      waiterRunning();
    });
  }
}

const price = { inputPerMTok: 1, outputPerMTok: 2 };

@Agent({
  name: "spender-agent",
  description: "Answers with a costly call once the waiter waits",
  prompt: "Hold for the waiter, then answer.",
  model: "test/spender",
  price,
  tools: [HoldForWaiterTool],
  input: { message: WorkflowStartTextDto },
  output: NoteDto,
})
export class SpenderAgent {}

@Agent({
  name: "waiter-agent",
  description: "Waits on a slow service",
  prompt: "Wait.",
  model: "test/waiter",
  price,
  tools: [WaitForAbortTool],
  input: { message: WorkflowStartTextDto },
  output: NoteDto,
})
export class WaiterAgent {}

@WorkflowStart({
  name: "parallel-budget-workflow-start",
  description: "A task for both branches",
  input: WorkflowStartTextDto,
})
export class ParallelBudgetWorkflowStart {}

@WorkflowFinish({
  name: "notes-workflow-finish",
  description: "Every branch's note",
  input: { notes: listOf(NoteDto) },
  output: NoteDto,
})
export class NotesWorkflowFinish {
  finish(input: { readonly notes: readonly Produced<NoteDto, unknown>[] }): NoteDto {
    return {
      text: input.notes
        .map((note) => note.value.text)
        .join("; "),
    };
  }
}

/** The side path of an exhausted budget: code only, no model. */
@Action({
  name: "note-budget-stop-action",
  description: "Notes that the budget stopped the launch",
  output: NoteDto,
})
export class NoteBudgetStopAction {
  execute(): Promise<NoteDto> {
    parallelBudgetLog.events.push("budget stop noted");
    return Promise.resolve({ text: "stopped by the budget" });
  }
}

@WorkflowFinish({
  name: "budget-stopped-workflow-finish",
  description: "The budget stopped the launch",
  output: NoteDto,
})
export class BudgetStoppedWorkflowFinish {}

const onBudget = toAction(NoteBudgetStopAction)
  .returns(NoteDto)
  .toFinish(BudgetStoppedWorkflowFinish);

/** Both branches at once; an exhausted budget takes `.onJoinError(…)`. */
@Workflow({
  name: "parallel-budget-workflow",
  version: "1.0.0",
  flow: [
    start(ParallelBudgetWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toParallelAgents(SpenderAgent, WaiterAgent)
      .join()
      .onJoinError(BudgetExceededError, onBudget)
      .returns(listOf(NoteDto))
      .toFinish(NotesWorkflowFinish),
  ],
})
export class ParallelBudgetWorkflow {}

/** The same launch without a handler: the budget fails the execution. */
@Workflow({
  name: "unhandled-budget-workflow",
  version: "1.0.0",
  flow: [
    start(ParallelBudgetWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toParallelAgents(SpenderAgent, WaiterAgent)
      .join()
      .returns(listOf(NoteDto))
      .toFinish(NotesWorkflowFinish),
  ],
})
export class UnhandledBudgetWorkflow {}

/** Both answers needed by a quorum: the budget stops it before. */
@Workflow({
  name: "quorum-budget-workflow",
  version: "1.0.0",
  flow: [
    start(ParallelBudgetWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toParallelAgents(SpenderAgent, WaiterAgent)
      .joinQuorum({ min: 2 })
      .onJoinError(BudgetExceededError, onBudget)
      .returns(listOf(NoteDto))
      .toFinish(NotesWorkflowFinish),
  ],
})
export class QuorumBudgetWorkflow {}

/** One task's agent in a child: the spender's or the waiter's moves, by the task's name. */
@Agent({
  name: "task-agent",
  description: "Does one task",
  prompt: "Do the task.",
  model: "test/task",
  price,
  tools: [HoldForWaiterTool, WaitForAbortTool],
  input: { task: TaskDto },
  output: NoteDto,
})
export class TaskAgent {}

@WorkflowStart({ name: "task-workflow-start", description: "One task", input: TaskDto })
export class TaskWorkflowStart {}

@WorkflowFinish({ name: "task-done-workflow-finish", description: "The note", output: NoteDto })
export class TaskDoneWorkflowFinish {}

/** The child: one task, one agent. */
@Workflow({
  name: "task-workflow",
  version: "1.0.0",
  flow: [
    start(TaskWorkflowStart)
      .returns(TaskDto)
      .toAgent(TaskAgent)
      .returns(NoteDto)
      .toFinish(TaskDoneWorkflowFinish),
  ],
})
export class TaskWorkflow {}

@WorkflowStart({
  name: "tasks-workflow-start",
  description: "The tasks, one child each",
  input: listOf(TaskDto),
})
export class TasksWorkflowStart {}

/** One child per task, all at once; an exhausted budget takes `.onJoinError(…)`. */
@Workflow({
  name: "tasks-budget-workflow",
  version: "1.0.0",
  flow: [
    start(TasksWorkflowStart)
      .returns(listOf(TaskDto))
      .toParallelWorkflows(TaskWorkflow, { maxItems: 4 })
      .join()
      .onJoinError(BudgetExceededError, onBudget)
      .returns(listOf(NoteDto))
      .toFinish(NotesWorkflowFinish),
  ],
})
export class TasksBudgetWorkflow {}

/**
 * One task as code: "wait" pays a service 3 cents and waits on its step's signal until aborted;
 * "spend" waits until the other runs, then pays 3 cents — together they cross 5 cents.
 */
@Action({
  name: "task-action",
  description: "Does one task by code",
  input: { task: TaskDto },
  output: NoteDto,
  deps: [ExecutionContext, SpendRecorder],
})
export class TaskAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async execute(input: { readonly task: Produced<TaskDto, unknown> }): Promise<NoteDto> {
    const { signal } = this.executionContext;
    if (input.task.value.name === "spend") {
      await isWaiterRunning;
      this.spendRecorder.record({ service: "slow-api", cost: usd(0.03) });
      return { text: "spent" };
    }
    this.spendRecorder.record({ service: "slow-api", cost: usd(0.03) });
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const reason: unknown = signal.reason;
        parallelBudgetLog.aborts.push(reason instanceof Error ? reason.name : String(reason));
        reject(reason instanceof Error ? reason : new Error("aborted"));
      });
      waiterRunning();
    });
  }
}

/** One action per task, all at once; an exhausted budget takes `.onJoinError(…)`. */
@Workflow({
  name: "task-actions-budget-workflow",
  version: "1.0.0",
  flow: [
    start(TasksWorkflowStart)
      .returns(listOf(TaskDto))
      .toParallelActions(TaskAction, { maxItems: 4 })
      .join()
      .onJoinError(BudgetExceededError, onBudget)
      .returns(listOf(NoteDto))
      .toFinish(NotesWorkflowFinish),
  ],
})
export class TaskActionsBudgetWorkflow {}

/** The execution may spend 5 cents: the spender's 6-cent call crosses it. */
@Budget({ name: "tight-execution-budget", scope: BudgetScope.Execution })
export class TightExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

/** The tenant may spend 5 cents a day: only the two branches together cross it. */
@Budget({ name: "tight-tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TightTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

const TIGHT_EXECUTION = [TestApplicationDailyBudget, TestTenantDailyBudget, TightExecutionBudget];

const application = {
  version: "1.0.0",
  environment: EmptyEnvironment,
  providers: [ParallelCostLedgerRepository],
} as const;

@Application({
  ...application,
  name: "parallel-budget-application",
  workflows: [ParallelBudgetWorkflow],
  budgets: TIGHT_EXECUTION,
})
export class ParallelBudgetApplication {}

@Application({
  ...application,
  name: "unhandled-budget-application",
  workflows: [UnhandledBudgetWorkflow],
  budgets: TIGHT_EXECUTION,
})
export class UnhandledBudgetApplication {}

@Application({
  ...application,
  name: "quorum-budget-application",
  workflows: [QuorumBudgetWorkflow],
  budgets: TIGHT_EXECUTION,
})
export class QuorumBudgetApplication {}

@Application({
  ...application,
  name: "tasks-budget-application",
  workflows: [TasksBudgetWorkflow],
  budgets: TIGHT_EXECUTION,
})
export class TasksBudgetApplication {}

@Application({
  ...application,
  name: "task-actions-budget-application",
  workflows: [TaskActionsBudgetWorkflow],
  budgets: TIGHT_EXECUTION,
})
export class TaskActionsBudgetApplication {}

@Application({
  ...application,
  name: "tenant-budget-application",
  workflows: [ParallelBudgetWorkflow],
  budgets: [TestApplicationDailyBudget, TightTenantDailyBudget, TestExecutionBudget],
})
export class TenantBudgetApplication {}
