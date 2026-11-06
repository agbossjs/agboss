import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/** #799 negative fixture: a set that does not say what its stores decide a lease's time by. */
const { storeTime: _dropped, ...undeclared } = sqlite;
export const faultStores = undeclared;
