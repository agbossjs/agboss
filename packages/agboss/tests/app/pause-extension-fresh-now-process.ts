/**
 * #1148: the process of the real-clock test, on a SQLite file: `node --import tsx pause-extension-fresh-now-process.ts <file>`.
 * A pause is asked with a plain 2 s deadline; 1.2 s later it is extended by working time through a calendar that
 * really takes 3 s, so the deadline passes inside the calendar while the channel's expiry handler is entered and
 * held. It reports (IPC, #1128) what the extension did and what is stored.
 */
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { workingMinutes } from "../../src/units/index.js";
import { report } from "../helpers/child-channel.js";
import { execute } from "../helpers/flow.js";
import {
  desk,
  fresh,
  SqliteFreshNowProcessApplication,
} from "../infrastructure/sqlite/fixtures/fresh-now-process.application.js";

const [file = ""] = process.argv.slice(2);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const app = await createTestAppWith(SqliteFreshNowProcessApplication, {
  processEnv: { ...process.env, AGBOSS_SQLITE_TEST_PATH: file },
});
try {
  await execute(app, desk.start, { orderId: "o-1" }, { threadId: "t-1" });
  const pauseId = desk.told.sent.at(-1)?.pauseId ?? "";
  const store = app.resolve(PausedExecutionRepository);
  const deadline = (await store.findByTenantIdAndPauseId("default", pauseId))?.expiresAt;
  await sleep(1200);
  fresh.slow = true;
  const outcome = await app
    .extendPause({ pauseId, expiresIn: workingMinutes(1) }, { answeredBy: "manager-17" })
    .then(
      (done) => ({ ok: true, expiresAt: done.expiresAt }),
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.name : String(error),
      }),
    );
  const nowAtAnswer = new Date().toISOString();
  fresh.release();
  const stored = await store.findByTenantIdAndPauseId("default", pauseId);
  await report({
    deadline,
    nowAtAnswer,
    expired: fresh.expired,
    outcome,
    storedExpiresAt: stored?.expiresAt,
  });
} finally {
  fresh.release();
  await app.close();
}
process.exit(0);
