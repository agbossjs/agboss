import { FaultStoreTime } from "../../src/testing/faults/index.js";
import { faultStores as realClock } from "./real-clock.fault-stores.js";

/** #959 fixture: the real-clock lease store declared as what it is — the database's own clock. */
export const faultStores = { ...realClock, storeTime: FaultStoreTime.Database };
