import { env } from "../../../../../src/index.js";
import type { SqliteTestEnvironment } from "./app.environment.js";

/** `createApp` (dev): the same file as the tests (`AGBOSS_SQLITE_TEST_PATH`), else in memory. */
export const environment: SqliteTestEnvironment = {
  sqlitePath: env("AGBOSS_SQLITE_TEST_PATH", { default: ":memory:" }),
};
