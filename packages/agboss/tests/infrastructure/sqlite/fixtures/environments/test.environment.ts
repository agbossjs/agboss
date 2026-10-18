import { env } from "../../../../../src/index.js";
import type { SqliteTestEnvironment } from "./app.environment.js";

/** The test's file (`AGBOSS_SQLITE_TEST_PATH`, set per test file), else a database in memory. */
export const environment: SqliteTestEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_TEST_PATH", { default: ":memory:" }),
};
