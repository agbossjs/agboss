import { env } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

/**
 * Two instances on one database, for `testWith(App, { instances: 2, env: "instances" })`: the
 * SQLite stores are shared through their file (`:memory:` is one database per connection). The
 * file is the test's own (`FLOW_PATTERNS_INSTANCES_SQLITE`, set per test by
 * `instancesFilePerTest()`, #550): no default, so a test that shares one cannot start.
 */
export const environment: AppEnvironment = {
  sqlitePath: env("FLOW_PATTERNS_INSTANCES_SQLITE"),
};
