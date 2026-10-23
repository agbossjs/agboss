import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEnvironment } from "./app.environment.js";

/**
 * Two instances on one database, for `testWith(App, { instances: 2, env: "instances" })`: the
 * SQLite stores are shared through their file (`:memory:` is one database per connection), a fresh
 * one per test process.
 */
export const environment: AppEnvironment = {
  sqlitePath: join(mkdtempSync(join(tmpdir(), "flow-patterns-instances-")), "stores.sqlite"),
};
