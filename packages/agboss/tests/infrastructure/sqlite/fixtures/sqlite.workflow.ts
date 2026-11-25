import { Window1Memory } from "../../../helpers/window-memory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";
import {
  ApplicationContext,
  Clock,
  Injectable,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
  Workflow,
  type ExecutionLease,
  Ttl,
} from "../../../../src/index.js";
import { SqliteCheckpointSaver } from "../../../../src/internal.js";
import { SqliteConnection } from "../../../../src/infrastructure/sqlite/sqlite-connection.js";
import { Application } from "../../../../src/application/application.js";
import { seconds, type Milliseconds } from "../../../../src/units/index.js";
import { UnwindLog, UnwindWorkflow } from "../../../flow/runtime/fixtures/unwind.workflow.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import {
  Clerk,
  levers,
  OrderWorkflowStart,
  ReceiptWorkflowFinish,
  RecoveryLog,
  RecoveryWorkflow,
  seen,
} from "../../fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { storeClockOf } from "../../../helpers/store-clock.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #265 PR 3 — the recovery fixture's workflow in applications that list every SQLite
 * implementation on the test's file (`AGBOSS_SQLITE_TEST_PATH`, a new file per test): the lease
 * store's instances can be killed (a dead instance takes no lease and renews none — what a crashed
 * process looks like to the file), so a recovery runs across two connections to one file.
 */

/**
 * Points the SQLite fixtures of the calling test file at its own file, emptied before each test
 * (the apps of a test open it lazily, after the hooks; the last test's apps are closed by then).
 */
export function sqliteFilePerTest(): { readonly path: string } {
  const folder = mkdtempSync(join(tmpdir(), "agboss-sqlite-app-"));
  const path = join(folder, "application.sqlite");
  process.env.AGBOSS_SQLITE_TEST_PATH = path;
  beforeEach(() => {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  });
  afterAll(() => {
    delete process.env.AGBOSS_SQLITE_TEST_PATH;
    rmSync(folder, { recursive: true, force: true });
  });
  return { path };
}

/** The leases on the file; a dead instance takes none and renews none. */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class MortalSqliteExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  readonly #instanceId: string;

  constructor(connection: SqliteConnection, clock: Clock, applicationContext: ApplicationContext) {
    super(connection, storeClockOf(clock), applicationContext);
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

  override renew(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<Milliseconds | undefined> {
    if (levers.dead.has(this.#instanceId)) return Promise.resolve(undefined);
    return super.renew(executionLease, lease);
  }
  override yield(executionLease: ExecutionLease): Promise<Milliseconds | undefined> {
    if (levers.dead.has(this.#instanceId)) return Promise.resolve(undefined);
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

/** Every SQLite implementation but the lease store. */
const SQLITE_STORES = [
  SqliteExecutionRecordRepository,
  SqlitePausedExecutionRepository,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionTreeRepository,
  SqliteRateLimitRepository,
];

@Application({
  name: "sqlite-recovery-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [RecoveryWorkflow],
  observers: [RecoveryLog],
  providers: [MortalSqliteExecutionLeaseRepository, ...SQLITE_STORES],
  budgets: TEST_BUDGETS,
})
export class SqliteRecoveryApplication {}

/** The same clerk in a workflow of its own: only one application lists it (eval, replay). */
@Workflow({
  name: "note-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    tools: { maxToolCalls: 8 },
  },
  memory: Window1Memory,
  flow: [
    onStart(OrderWorkflowStart)
      .toAgent(Clerk)
      .toFinish(ReceiptWorkflowFinish),
  ],
})
export class NoteWorkflow {}

@Application({
  name: "sqlite-note-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [NoteWorkflow],
  observers: [RecoveryLog],
  providers: [SqliteExecutionLeaseRepository, ...SQLITE_STORES],
  budgets: TEST_BUDGETS,
})
export class SqliteNoteApplication {}

/** #340 PR 4 — the undo of `unwind.workflow.ts` on the file: an interrupted one is finished elsewhere. */
@Application({
  name: "sqlite-unwind-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [UnwindWorkflow],
  observers: [UnwindLog],
  providers: [MortalSqliteExecutionLeaseRepository, ...SQLITE_STORES],
  budgets: TEST_BUDGETS,
  executionLimits: { compensationTimeout: seconds(60) },
})
export class SqliteUnwindApplication {}
