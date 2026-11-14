/**
 * #1093: a script that only calls a public method — `node --import tsx cancel-process.ts cancel
 * <threadId>`, or `resume <pauseId>` — and prints its result. Nothing else keeps this process alive: if the call's own
 * waits are unref'd timers, Node exits with code 13 in the middle of it.
 */
import { createApp } from "../../../../src/application/create-app.js";
import { HeldCancelApplication } from "./held-cancel.application.js";

const [operation, id] = process.argv.slice(2);
if (id === undefined) throw new Error("usage: cancel <threadId> | resume <pauseId>");
const app = await createApp(HeldCancelApplication, { env: "dev" });
if (operation === "cancel") {
  process.stdout.write(`result ${JSON.stringify(await app.cancel(id))}\n`);
} else {
  const resumed = await app.resume(
    { pauseId: id, decision: { approved: true } },
    { answeredBy: "the director" },
  );
  process.stdout.write(`result finished=${String(resumed.finish !== undefined)}\n`);
}
await app.close();
process.stdout.write("closed\n");
