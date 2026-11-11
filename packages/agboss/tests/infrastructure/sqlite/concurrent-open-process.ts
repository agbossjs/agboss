/**
 * #911: one of N processes opening one SQLite file at the same moment, as an application instance
 * does: `node --import tsx concurrent-open-process.ts <path>`. It prints `ready`, waits for a line
 * on stdin (the barrier — every process has loaded by then), opens the connection and creates a
 * store's table, and prints `opened`; a failure prints `failed: <message>` and exits 1.
 */
import { createInterface } from "node:readline";
import { createContainer } from "../../../src/components/container/container.js";
import type { Token } from "../../../src/components/injection.js";
import { resolveEnvironment } from "../../../src/environments/resolve.js";
import {
  ApplicationContext,
  applicationContextOf,
} from "../../../src/flow/context/application-context.js";
import { SqliteConnection } from "../../../src/infrastructure/sqlite/sqlite-connection.js";

const path = process.argv[2] ?? "";
process.stdout.write("ready\n");
for await (const _line of createInterface({ input: process.stdin })) break;
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
  connection.ensureSchema("notes", "CREATE TABLE IF NOT EXISTS notes (text TEXT NOT NULL);");
  connection.transaction(() => {
    connection.database.exec("INSERT INTO notes VALUES ('x')");
  });
  process.stdout.write("opened\n");
  process.exit(0);
} catch (error) {
  process.stdout.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
