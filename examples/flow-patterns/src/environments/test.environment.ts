import type { AppEnvironment } from "./app.environment.js";

/** What `testWith(FlowPatternsApplication)` runs on: the ledger in memory, one per instance. */
export const environment: AppEnvironment = { sqlitePath: ":memory:" };
