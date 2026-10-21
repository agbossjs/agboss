import { Injectable } from "../../components/decorators.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { sharedTernStore } from "../../terns/index.js";
import { Clock, IdGenerator } from "../clock.js";
import { TernStoreRecordRepository } from "../execution-record.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

/**
 * `ExecutionRecordRepository` on the application's SQLite file (#265, S32): threads, records,
 * scores, summaries and config snapshots in the Tern tables, migrated on first use — so
 * `agboss eval` / `replay` / `golden` and `--thread` see the records of earlier processes, and
 * recovery finds the roots a dead instance left `running`. Status writes that must not land late
 * are compare-and-set (`completeIfStatus`, one statement). A new thread's id comes from the
 * application's `IdGenerator` (#313). Listed in `@Application({ providers })`; needs `sqlitePath`.
 * A project subclasses it through public tokens only (#265 S70): `@Injectable({ deps:
 * [SqliteConnection, Clock, ApplicationContext, IdGenerator] })`, the same `deps` as this class.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, IdGenerator] })
export class SqliteExecutionRecordRepository extends TernStoreRecordRepository {
  constructor(
    private readonly connection: SqliteConnection,
    clock: Clock,
    applicationContext: ApplicationContext,
    idGenerator: IdGenerator,
  ) {
    super(sharedTernStore(connection.database, () => clock.now(), idGenerator));
  }

  override ping(): Promise<void> {
    return this.connection.ping();
  }
}

sqliteImplementation(SqliteExecutionRecordRepository);
