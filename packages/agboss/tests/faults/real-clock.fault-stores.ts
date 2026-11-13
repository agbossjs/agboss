import { Injectable } from "../../src/components/decorators.js";
import { ApplicationContext } from "../../src/flow/context/application-context.js";
import { StoreClock, StoreTimeSource, systemClock } from "../../src/infrastructure/clock.js";
import { SqliteConnection, SqliteExecutionLeaseRepository } from "../../src/index.js";
import { FaultStoreTime } from "../../src/testing/faults/index.js";
import { faultStores as sqlite, sqliteFaultStoreClasses } from "./sqlite.fault-stores.js";

/**
 * #959 fixture: a SQLite set whose lease store decides by the real clock whatever the pods' timeScale —
 * what a database's own clock does — declared as the host's (the pods' timeScale): a wrong but valid
 * declaration, the lease clock and the history's time scale disagreeing.
 */
@Injectable({ deps: [SqliteConnection, ApplicationContext] })
export class RealClockLeaseRepository extends SqliteExecutionLeaseRepository {
  constructor(connection: SqliteConnection, applicationContext: ApplicationContext) {
    super(connection, new StoreClock(StoreTimeSource.Database, systemClock), applicationContext);
  }
}

export const faultStores = {
  ...sqlite,
  providers: sqliteFaultStoreClasses.map((store) =>
    store === SqliteExecutionLeaseRepository ? RealClockLeaseRepository : store,
  ),
  storeTime: FaultStoreTime.Host,
};
