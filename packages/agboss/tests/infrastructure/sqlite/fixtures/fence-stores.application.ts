import { DatabaseSync } from "node:sqlite";
import {
  ApplicationContext,
  Clock,
  ExecutionFencedError,
  Injectable,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  type ExecutionLease,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { InMemoryExecutionLeaseRepository } from "../../../../src/infrastructure/execution-lease.repository.js";
import { IN_MEMORY_DATABASE } from "../../../../src/infrastructure/in-memory-database.js";
import type { Milliseconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { RecoveryLog } from "../../fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import {
  ledger,
  ReleaseWorkflow,
  Staged,
  type LedgerRow,
} from "../../../app/fixtures/fence.workflow.js";

/**
 * #471 AC2, AC5 — the release on other stores: the external ledger in its own SQLite file (each
 * instance its own connection, the fence check and the idempotency key in one `BEGIN IMMEDIATE`
 * transaction — the reference SQL of Wiki → Several-instances), and AGBoss's own stores on SQLite or
 * on a project's own lease store. `leases.stall` works on any of them: it wraps the contract.
 */

/** The external ledger's file of the current test (set by the test). */
export const external: { path: string } = { path: ":memory:" };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fence_marks (
    scope_key TEXT PRIMARY KEY,
    highest_token INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS release_artifacts (
    idempotency_key TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    token INTEGER NOT NULL,
    artifact TEXT NOT NULL
  );
`;

/** The high-water mark of the scope, raised to the write's token unless it is already above it. */
const RAISE_MARK = `
  INSERT INTO fence_marks (scope_key, highest_token) VALUES (?, ?)
  ON CONFLICT (scope_key) DO UPDATE SET highest_token = excluded.highest_token
  WHERE excluded.highest_token >= fence_marks.highest_token
  RETURNING highest_token
`;

const INSERT_ARTIFACT = `
  INSERT INTO release_artifacts (idempotency_key, scope_key, token, artifact) VALUES (?, ?, ?, ?)
  ON CONFLICT (idempotency_key) DO NOTHING
`;

const HIGHEST = `SELECT highest_token AS highest FROM fence_marks WHERE scope_key = ?`;

/** The rows of the external ledger's file. */
export function externalRows(): readonly LedgerRow[] {
  const database = new DatabaseSync(external.path);
  try {
    database.exec(SCHEMA);
    const rows = database
      .prepare(
        "SELECT scope_key AS scopeKey, token, idempotency_key AS idempotencyKey, artifact FROM release_artifacts ORDER BY rowid",
      )
      .all();
    return rows.map((row) => ({
      scopeKey: String(row.scopeKey),
      token: Number(row.token),
      idempotencyKey: String(row.idempotencyKey),
      artifact: String(row.artifact),
    }));
  } finally {
    database.close();
  }
}

/**
 * The ledger in SQLite: one transaction raises the scope's mark (`incoming >= highest`) and writes
 * the artifact once by its key; a token below the mark is refused (`ExecutionFencedError`).
 */
@Injectable()
export class SqliteArtifactLedger {
  readonly #database = new DatabaseSync(external.path, { timeout: 5000 });

  constructor() {
    this.#database.exec(SCHEMA);
  }

  stage(row: LedgerRow): Staged {
    const database = this.#database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const raised = database.prepare(RAISE_MARK).get(row.scopeKey, row.token);
      if (raised === undefined) {
        const found = database.prepare(HIGHEST).get(row.scopeKey);
        database.exec("ROLLBACK");
        ledger.refused.push({ scopeKey: row.scopeKey, token: row.token });
        throw new ExecutionFencedError({
          scopeKey: row.scopeKey,
          token: row.token,
          observedToken: Number(found?.highest),
        });
      }
      const inserted = database
        .prepare(INSERT_ARTIFACT)
        .run(row.idempotencyKey, row.scopeKey, row.token, row.artifact);
      database.exec("COMMIT");
      return inserted.changes === 0 ? Staged.Deduplicated : Staged.Written;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }
}

/** AGBoss's own stores on the test's SQLite file (`AGBOSS_SQLITE_TEST_PATH`). */
@Application({
  name: "fence-sqlite-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [ReleaseWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  providers: [
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqliteExecutionTreeRepository,
    SqlitePausedExecutionRepository,
  ],
})
export class FenceSqliteApplication {}

/** A project's own lease store (here over the test's memory): every call counted. */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class CountedExecutionLeaseRepository extends InMemoryExecutionLeaseRepository {
  static calls = 0;

  override acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    CountedExecutionLeaseRepository.calls += 1;
    return super.acquire(tenantId, rootExecutionId, lease);
  }

  override renew(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<Milliseconds | undefined> {
    CountedExecutionLeaseRepository.calls += 1;
    return super.renew(executionLease, lease);
  }
}

@Application({
  name: "fence-own-leases-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [ReleaseWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  providers: [CountedExecutionLeaseRepository],
})
export class FenceOwnLeasesApplication {}
