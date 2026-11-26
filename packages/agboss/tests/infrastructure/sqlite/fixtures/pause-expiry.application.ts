import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  DirectorChannel,
  ExpiryLog,
  ExpiryWorkflow,
  ManagerChannel,
  ReviewerChannel,
} from "../../../flow/fixtures/expiry.fixture.js";
import { RecordingLogger } from "../../../helpers/log.js";
import { sqliteTestStorage } from "./sqlite-test-storage.js";
import { MortalSqliteExecutionLeaseRepository } from "./sqlite.workflow.js";

/**
 * #941 — the expiry fixture's workflow (a manager's question with a 24 h deadline, the director
 * asked when it expires) in an application on the SQLite file: instances of it share the file, so
 * the look of one finds the pauses of another, and a dead instance (the lease store's lever) takes
 * and renews no lease.
 */
@Application({
  name: "sqlite-expiry-application",
  version: "1.0.0",
  storage: sqliteTestStorage({ replace: [MortalSqliteExecutionLeaseRepository] }),
  workflows: [ExpiryWorkflow],
  observers: [ExpiryLog],
  providers: [ManagerChannel, DirectorChannel, ReviewerChannel, RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class SqliteExpiryApplication {}
