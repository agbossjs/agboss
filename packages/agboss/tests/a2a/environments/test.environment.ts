import { env } from "../../../src/index.js";
import type { SqliteTestEnvironment } from "../../infrastructure/sqlite/fixtures/environments/app.environment.js";

/** The SQLite applications of this folder's tests: the test's file, else a database in memory. */
export const environment: SqliteTestEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_TEST_PATH", { default: ":memory:" }),
};
