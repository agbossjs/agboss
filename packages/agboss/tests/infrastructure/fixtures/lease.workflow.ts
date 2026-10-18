import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  ExecutionContext,
  ExecutionRecordStatus,
  ExecutionTreeRepository,
  Injectable,
  PauseStatus,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type AppState,
  type ExecutionTreeValue,
  type OnError,
  type OnWorkflowResume,
  type PausedRun,
  type ToolHandler,
  type WorkflowResumeEvent,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { TernStoreRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import {
  createSqliteTernStore,
  type NewTern,
  type Tern,
  type TernOutcome,
} from "../../../src/terns/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { EmptyEnvironment } from "../../../src/index.js";

/**
 * #265 PR 1 — a clerk that charges (each charge waits for an approval), holds (the first hold
 * waits until its execution is stopped) and claims keys of its execution tree; the application
 * lists its own paused-execution store (with a hook the tests use to answer a pause while its
 * tree still moves) and execution records (every write seen).
 */

/** What the components and stores saw, in order (reset with `resetLease`). */
export const seen = {
  charges: [] as string[],
  holds: [] as AbortSignal[],
  claims: [] as boolean[],
  recalls: [] as (ExecutionTreeValue | undefined)[],
  trees: [] as ExecutionTreeRepository[],
  errors: [] as Error[],
  resumes: [] as unknown[],
  appended: [] as string[],
  completed: [] as string[],
  /** Each compare-and-set write: the status it wrote and whether it landed. */
  guarded: [] as { readonly status: string; readonly landed: boolean }[],
  records: [] as SeenExecutionRecordRepository[],
};

/** The test's hooks: run after a pause is saved; resolves when the first hold starts. */
export const hooks: {
  afterSave?: (paused: PausedRun, repository: HookedPausedExecutionRepository) => Promise<void>;
  holdStarted?: () => void;
  /** Runs before a compare-and-set record write (a resume's `running`). */
  beforeGuardedWrite?: () => Promise<void>;
} = {};

export function resetLease(): void {
  for (const list of Object.values(seen)) list.length = 0;
  delete hooks.afterSave;
  delete hooks.holdStarted;
  delete hooks.beforeGuardedWrite;
}

export class ReceiptDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

export class Query {
  @Text({ prompt: "what to do" })
  text!: string;
}

/** A write: each call waits for an approval. */
@Tool({
  name: "charge",
  description: "Charges the card",
  channel: TerminalUserChannel,
  input: Query,
  output: Query,
})
export class Charge implements ToolHandler<Query, Query> {
  run(input: Query): Promise<Query> {
    seen.charges.push(input.text);
    return Promise.resolve(input);
  }
}

/** The first call waits until its execution is stopped (a holder frozen in a long call); later ones return. */
@Tool({
  name: "hold",
  description: "Waits",
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Hold implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: Query): Promise<Query> {
    const { signal } = this.executionContext;
    seen.holds.push(signal);
    if (seen.holds.length > 1) return Promise.resolve(input);
    hooks.holdStarted?.();
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(input);
      });
    });
  }
}

/** Claims `claim:<text>` once per request (`saveIfAbsent`). */
@Tool({
  name: "claim",
  description: "Claims a key",
  input: Query,
  output: Query,
  deps: [ExecutionTreeRepository],
})
export class Claim implements ToolHandler<Query, Query> {
  constructor(private readonly executionTreeRepository: ExecutionTreeRepository) {}

  async run(input: Query): Promise<Query> {
    seen.trees.push(this.executionTreeRepository);
    seen.claims.push(await this.executionTreeRepository.saveIfAbsent(`claim:${input.text}`, true));
    return input;
  }
}

/** Reads `claim:<text>` of the request. */
@Tool({
  name: "recall",
  description: "Reads a key",
  input: Query,
  output: Query,
  deps: [ExecutionTreeRepository],
})
export class Recall implements ToolHandler<Query, Query> {
  constructor(private readonly executionTreeRepository: ExecutionTreeRepository) {}

  async run(input: Query): Promise<Query> {
    seen.recalls.push(await this.executionTreeRepository.findById(`claim:${input.text}`));
    return input;
  }
}

@Agent({
  name: "clerk-agent",
  description: "Charges, holds and claims",
  prompt: "Do what you are asked.",
  tools: [Charge, Hold, Claim, Recall],
  model: "test/clerk",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
})
export class Clerk {}

/** The errors and resumes the observers saw. */
@Injectable()
export class LeaseLog implements OnError, OnWorkflowResume {
  onError(error: Error, _state: AppState): void {
    seen.errors.push(error);
  }
  onWorkflowResume(event: WorkflowResumeEvent): void {
    seen.resumes.push(event.decision);
  }
}

/** The application's paused executions: in memory, with the test's hook after each save. */
@Injectable()
export class HookedPausedExecutionRepository extends InMemoryPausedExecutionRepository {
  override async save(paused: PausedRun): Promise<void> {
    await super.save(paused);
    if (paused.status === PauseStatus.Pending) await hooks.afterSave?.(paused, this);
  }
}

/** The application's execution records: in memory, every write seen. */
@Injectable()
export class SeenExecutionRecordRepository extends TernStoreRecordRepository {
  constructor() {
    super(createSqliteTernStore(":memory:"));
    seen.records.push(this);
  }

  override async completeIfStatus(
    ternId: string,
    expected: ExecutionRecordStatus,
    outcome: TernOutcome,
  ): Promise<boolean> {
    await hooks.beforeGuardedWrite?.();
    const landed = await super.completeIfStatus(ternId, expected, outcome);
    seen.guarded.push({ status: outcome.status, landed });
    return landed;
  }

  override append(tern: NewTern): Promise<Tern> {
    seen.appended.push(tern.status);
    return super.append(tern);
  }

  override complete(ternId: string, outcome: TernOutcome): Promise<void> {
    seen.completed.push(outcome.status);
    return super.complete(ternId, outcome);
  }
}

@WorkflowStart({
  name: "order-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class OrderWorkflowStart {}

@WorkflowFinish({ name: "receipt-workflow-finish", description: "The receipt", output: ReceiptDto })
export class ReceiptWorkflowFinish {}

@Workflow({
  name: "lease-workflow",
  version: "1.0.0",
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    history: { limit: 1 },
    tools: { maxToolCalls: 8 },
  },
  observers: [LeaseLog],
  channelClasses: [TerminalUserChannel],
  flow: [
    start(OrderWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .returns(ReceiptDto)
      .toFinish(ReceiptWorkflowFinish),
  ],
})
export class LeaseWorkflow {}

@Application({
  name: "lease-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LeaseWorkflow],
  providers: [HookedPausedExecutionRepository, SeenExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class LeaseApplication {}
