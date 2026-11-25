/**
 * #911: one of N processes opening one SQLite file at the same moment, as an application instance
 * does: `node --import tsx concurrent-open-process.ts <path>`. It reports `ready`, waits for `go`
 * from the parent (the barrier — every process has loaded by then), opens the connection and creates a
 * store's table, and reports `opened`; a failure reports `failed: <message>` and exits 1. Reports go
 * over IPC (#1128), never stdout.
 */
import { nextFromParent, report } from "../../helpers/child-channel.js";
import { createContainer } from "../../../src/components/container/container.js";
import type { Token } from "../../../src/components/injection.js";
import { resolveEnvironment } from "../../../src/environments/resolve.js";
import {
  ApplicationContext,
  applicationContextOf,
} from "../../../src/flow/context/application-context.js";
import { SqliteConnection } from "../../../src/infrastructure/sqlite/sqlite-connection.js";

const path = process.argv[2] ?? "";
await report("ready");
await nextFromParent();
try {
  const application = applicationContextOf({
    name: "concurrent-open",
    version: "1.0.0",
    instanceId: `instance-${String(process.pid)}`,
    startedAt: new Date(0),
    environmentName: "test",
    environment: resolveEnvironment(
      { name: "test", contract: "StoreEnvironment", values: { sqlitePath: path } },
      {},
    ),
  });
  const container = createContainer({
    modules: [],
    core: new Map<Token, unknown>([[ApplicationContext, application]]),
  });
  const connection = container.get(SqliteConnection);
  if (!(connection instanceof SqliteConnection)) throw new Error("not a SqliteConnection");
  // a use of the connection outside a repository operation goes through `serve`: it waits for another
  // process's lock asynchronously (SQLite's own wait is off once the connection is open, #1317c)
  await connection.serve(() => {
    connection.database.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT NOT NULL);");
  });
  await connection.serve(() => {
    connection.transaction(() => {
      connection.database.exec("INSERT INTO notes VALUES ('x')");
    });
  });
  await report("opened");
  process.exit(0);
} catch (error) {
  await report(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
