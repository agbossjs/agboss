// Run inside the folder 0.1.0 is installed in: `node writer.mjs <sqlite file> <json list of puts>`.
// Deep imports: 0.1.0 does not export its SQLite classes, its dist files are what ran in production.
import { emptyCheckpoint } from "@langchain/langgraph";

const dist = new URL("./node_modules/@agboss/core/dist/infrastructure/sqlite/", import.meta.url);
const { SqliteConnection } = await import(new URL("sqlite-connection.js", dist).href);
const { SqliteCheckpointSaver } = await import(new URL("sqlite-checkpoint-saver.js", dist).href);

const [path, json] = process.argv.slice(2);
const connection = new SqliteConnection({ environment: { sqlitePath: path } });
const saver = new SqliteCheckpointSaver(connection);
try {
  for (const put of JSON.parse(json)) {
    const config = {
      configurable: { thread_id: put.threadId ?? "t", checkpoint_ns: put.namespace ?? "" },
    };
    await saver.put(config, { ...emptyCheckpoint(), id: put.id }, put.metadata);
    // 0.1.0 reads what it wrote, through its own `SELECT *` on whatever the file now is
    const read = await saver.getTuple(config);
    if (read === undefined) throw new Error(`0.1.0 cannot read ${put.id} back`);
  }
} finally {
  connection.onDestroy();
}
