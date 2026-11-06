import { FaultStoreTime } from "../../src/testing/faults/index.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #799 fixture: the SQLite set declared on its database's own clock — what a PostgreSQL or MongoDB
 * set declares. (Its stores still read the pod's clock: the test reads only what the suite maps.)
 */
export const faultStores = { ...sqlite, storeTime: FaultStoreTime.Database };
