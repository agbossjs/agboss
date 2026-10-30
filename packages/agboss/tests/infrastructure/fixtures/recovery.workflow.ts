import { until } from "../../helpers/until.js";
import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  ExecutionContext,
  ExecutionRecordRepository,
  ExecutionRecordStatus,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionLease,
  type OnExecutionError,
  type OnExecutionEnd,
  type OnExecutionResume,
  type ToolHandler,
  type ExecutionResumeEvent,
} from "../../../src/index.js";
import { ApplicationContext, Clock } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/instance-tokens.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { TernStoreRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import type { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { createSqliteTernStore, type Tern } from "../../../src/terns/index.js";
import { seconds, type Milliseconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { RecordingLogger } from "../../helpers/log.js";

/**
 * #265 PR 2 — a clerk that takes steps (each one counted), holds (the first hold waits until its
 * execution is stopped, or the test lets it go) and charges (each charge waits for an approval).
 * The application lists a lease store whose instances the test can kill (a dead instance takes no
 * lease and renews none — what a crashed process looks like to the store), and execution records
 * whose `running` ones the test can stamp with another config (a record of another deploy).
 */

/** An execution that ended at a finish: the finish, and its output (from its record). */
export interface EndSeen {
  readonly finish: string;
  readonly output: unknown;
}

/** What the components and observers saw, in order (reset with `resetRecovery`). */
export const seen = {
  steps: [] as string[],
  holds: [] as AbortSignal[],
  /** Each hold's idempotency key (#335 AC2). */
  holdKeys: [] as string[],
  charges: [] as string[],
  resumes: [] as Pick<ExecutionResumeEvent, "reason" | "decision">[],
  ends: [] as EndSeen[],
  errors: [] as Error[],
  leases: [] as ExecutionLease[],
};

/**
 * The test's levers: the dead instances, the instances whose lease store does not answer (#335),
 * a hold to let go, a config to stamp the records with.
 */
export const levers: {
  readonly dead: Set<string>;
  readonly storeDown: Set<string>;
  holdStarted?: () => void;
  letGo?: () => void;
  stampedHash?: string;
} = { dead: new Set(), storeDown: new Set() };

/** The records the test's first instance created (the instances of a test share them). */
export const stores: { records?: StampedExecutionRecordRepository } = {};

export function resetRecovery(): void {
  delete stores.records;
  for (const list of Object.values(seen)) list.length = 0;
  levers.dead.clear();
  levers.storeDown.clear();
  delete levers.holdStarted;
  delete levers.letGo;
  delete levers.stampedHash;
}

/** Kills an instance (`instance-1`, …): from now on it takes no lease and keeps none. */
export const kill = (instanceId: string): void => {
  levers.dead.add(instanceId);
};

/** Until the observers saw `count` ends (a recovery runs in the background of its instance). */
export async function ends(count: number): Promise<readonly EndSeen[]> {
  // in real time, not in turns (#509); short of `count`, the test's own expectation names it
  try {
    await until(() => seen.ends.length >= count, `${String(count)} ends seen`);
  } catch {
    // fewer ends than asked for: the caller's expectation reports it
  }
  return seen.ends;
}

export class ReceiptDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

export class Query {
  @Text({ prompt: "what to do" })
  text!: string;
}

/** A step: counted, so a test sees whether it ran again. */
@Tool({ name: "step-tool", description: "Takes a step", input: Query, output: Query })
export class Step implements ToolHandler<Query, Query> {
  run(input: Query): Promise<Query> {
    seen.steps.push(input.text);
    return Promise.resolve(input);
  }
}

/** The first call waits until its execution is stopped or the test lets it go; later ones return. */
@Tool({
  name: "hold-tool",
  description: "Waits",
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Hold implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: Query): Promise<Query> {
    const { signal, step } = this.executionContext;
    seen.holds.push(signal);
    seen.holdKeys.push(step.idempotencyKey);
    if (seen.holds.length > 1) return Promise.resolve(input);
    return new Promise((resolve) => {
      levers.letGo = () => {
        resolve(input);
      };
      signal.addEventListener("abort", () => {
        resolve(input);
      });
      levers.holdStarted?.();
    });
  }
}

/** A write: each call waits for an approval. */
@Tool({
  name: "charge-tool",
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

@Agent({
  name: "clerk-agent",
  description: "Steps, holds and charges",
  prompt: "Do what you are asked.",
  tools: [Step, Hold, Charge],
  model: "test/clerk",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
})
export class Clerk {}

/**
 * What the observers saw: resumes (with their reason), ends and errors. An event carries no DTO
 * value, so an end's output is read from the execution's record (its finish line).
 */
@Injectable({ deps: [ExecutionRecordRepository] })
export class RecoveryLog implements OnExecutionResume, OnExecutionEnd, OnExecutionError {
  constructor(private readonly executionRecordRepository: ExecutionRecordRepository) {}

  onExecutionResume(event: ExecutionResumeEvent): void {
    seen.resumes.push({ reason: event.reason, decision: event.decision });
  }
  async onExecutionEnd(event: ExecutionEndEvent): Promise<void> {
    const [record] = await this.executionRecordRepository.lastTerns(
      event.tenantId,
      event.threadId,
      1,
    );
    const line = record?.replyWith ?? "";
    const prefix = `finish ${event.finish.name}: `;
    const output: unknown = line.startsWith(prefix) ? JSON.parse(line.slice(prefix.length)) : line;
    seen.ends.push({ finish: event.finish.name, output });
  }
  onExecutionError(event: ExecutionErrorEvent): void {
    seen.errors.push(event.error);
  }
}

/**
 * The leases in the test's memory; a dead instance takes none and renews none; an instance whose
 * store is down (`levers.storeDown`) gets an error from every renewal.
 */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class MortalExecutionLeaseRepository extends InMemoryExecutionLeaseRepository {
  readonly #instanceId: string;

  constructor(clock: Clock, applicationContext: ApplicationContext, database: InMemoryDatabase) {
    super(clock, applicationContext, database);
    this.#instanceId = applicationContext.instanceId;
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    if (levers.dead.has(this.#instanceId)) return undefined;
    const taken = await super.acquire(tenantId, rootExecutionId, lease);
    if (taken !== undefined) seen.leases.push(taken);
    return taken;
  }

  override renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    if (levers.storeDown.has(this.#instanceId)) {
      return Promise.reject(new Error("the lease store does not answer"));
    }
    if (levers.dead.has(this.#instanceId)) return Promise.resolve(false);
    return super.renew(executionLease, lease);
  }
  override yield(executionLease: ExecutionLease): Promise<boolean> {
    if (levers.dead.has(this.#instanceId)) return Promise.resolve(false);
    return super.yield(executionLease);
  }

  override async reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    if (levers.dead.has(this.#instanceId)) return undefined;
    const reclaimed = await super.reclaim(executionLease, lease);
    if (reclaimed !== undefined) seen.leases.push(reclaimed);
    return reclaimed;
  }
}

/** The records in memory; `levers.stampedHash` makes the running ones read as another deploy's. */
@Injectable()
export class StampedExecutionRecordRepository extends TernStoreRecordRepository {
  constructor() {
    super(createSqliteTernStore(":memory:", () => new Date()));
    stores.records ??= this;
  }

  override async findByStatus(
    status: ExecutionRecordStatus,
    limit: number,
    after?: string,
  ): Promise<Tern[]> {
    const page = await super.findByStatus(status, limit, after);
    const configHash = levers.stampedHash;
    return configHash === undefined ? page : page.map((record) => ({ ...record, configHash }));
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
  name: "recovery-workflow",
  version: "1.0.0",
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    tools: { maxToolCalls: 8 },
  },
  uncompactedTurns: 1,
  flow: [
    start(OrderWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .returns(ReceiptDto)
      .toFinish(ReceiptWorkflowFinish),
  ],
})
export class RecoveryWorkflow {}

const providers = [
  MortalExecutionLeaseRepository,
  StampedExecutionRecordRepository,
  RecordingLogger,
];

@Application({
  name: "recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  observers: [RecoveryLog],
  providers,
  budgets: TEST_BUDGETS,
})
export class RecoveryApplication {}

/** The same application with its own shutdown timeout. */
@Application({
  name: "quick-stop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  observers: [RecoveryLog],
  providers,
  budgets: TEST_BUDGETS,
  shutdownTimeout: seconds(5),
})
export class QuickStopApplication {}
