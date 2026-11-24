/**
 * #1099: one process of the racing-extensions test, on a SQLite file shared with another:
 * `node --import tsx pause-extension-process.ts <file> setup <count>` asks <count> pauses and reports their ids;
 * `... <file> extend <hours> <ids as JSON>` reports `ready`, waits for `go` from the parent, then extends each
 * pause at its own wall-clock slot (the other process does the same at the same slots) and reports one
 * message per pause: `{ pauseId, ok, expiresAt, previousExpiresAt, error }`;
 * `... <file> dump <ids as JSON>` reports `{ [pauseId]: expiresAt }`. Results go over IPC (#1128), never stdout.
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { nextFromParent, report } from "../helpers/child-channel.js";
import { hours } from "../../src/units/index.js";
import { SqliteExtensionProcessApplication } from "../infrastructure/sqlite/fixtures/pause-extension-process.application.js";
import { execute } from "../helpers/flow.js";
import { managerFlow, told } from "../flow/fixtures/pause-extension.fixture.js";

const [file = "", mode = "", first = "", second = ""] = process.argv.slice(2);
const SLOT_MS = 40;

const app = await createTestAppWith(SqliteExtensionProcessApplication, {
  processEnv: { ...process.env, AGBOSS_SQLITE_TEST_PATH: file },
});
try {
  if (mode === "setup") {
    for (let index = 0; index < Number(first); index += 1)
      await execute(
        app,
        managerFlow.start,
        { orderId: `o-${String(index)}` },
        { threadId: `t-${String(index)}` },
      );
    await report(told.sent.map((ask) => ask.pauseId));
  } else if (mode === "extend") {
    const pauseIds = JSON.parse(second) as string[];
    await report("ready");
    await nextFromParent();
    const begin = Math.ceil(Date.now() / 1000) * 1000 + 1000;
    for (const [index, pauseId] of pauseIds.entries()) {
      const wait = begin + index * SLOT_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const outcome = await app
        .extendPause({ pauseId, expiresIn: hours(Number(first)) }, { answeredBy: "manager-17" })
        .then(
          (done) => ({
            ok: true,
            expiresAt: done.expiresAt,
            previousExpiresAt: done.previousExpiresAt,
          }),
          (error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.name : String(error),
          }),
        );
      await report({ pauseId, ...outcome });
    }
  } else {
    const store = app.resolve(PausedExecutionRepository);
    const dump: Record<string, string | undefined> = {};
    for (const pauseId of JSON.parse(first) as string[])
      dump[pauseId] = (await store.findByTenantIdAndPauseId("default", pauseId))?.expiresAt;
    await report(dump);
  }
} finally {
  await app.close();
}
process.exit(0);
