import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";
import { TerminalUserChannel } from "../../../../src/channels/terminal-channel.js";
import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  ApplicationContext,
  Clock,
  Injectable,
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
  Workflow,
  type ExecutionLease,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import type { Milliseconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";
import {
  Clerk,
  levers,
  OrderWorkflowStart,
  ReceiptDto,
  ReceiptWorkflowFinish,
  RecoveryLog,
  RecoveryWorkflow,
  seen,
} from "../../fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

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
    super(connection, clock, applicationContext);
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
    if (levers.dead.has(this.#instanceId)) return Promise.resolve(false);
    return super.renew(executionLease, lease);
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
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    history: { limit: 1 },
    tools: { maxToolCalls: 8 },
  },
  channelClasses: [TerminalUserChannel],
  flow: [
    start(OrderWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .returns(ReceiptDto)
      .toFinish(ReceiptWorkflowFinish),
  ],
})
export class NoteWorkflow {}

@Application({
  name: "sqlite-note-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [NoteWorkflow],
  observers: [RecoveryLog],
  providers: [SqliteExecutionLeaseRepository, ...SQLITE_STORES],
  budgets: TEST_BUDGETS,
})
export class SqliteNoteApplication {}
