/**
 * #1093: a script that only calls a public method — `node --import tsx cancel-process.ts cancel
 * <threadId>`, or `resume <pauseId>`, `extend <pauseId>` or `reassign <pauseId>` — and prints its result. Nothing else keeps this process alive: if the call's own
 * waits are unref'd timers, Node exits with code 13 in the middle of it.
 */
import { hours } from "../../../../src/units/index.js";
import { createApp } from "../../../../src/application/create-app.js";
import { HeldCancelApplication } from "./held-cancel.application.js";

const [operation, id] = process.argv.slice(2);
if (id === undefined) throw new Error("usage: cancel <threadId> | resume <pauseId>");
const app = await createApp(HeldCancelApplication, { env: "dev" });
if (operation === "extend") {
  const extension = await app.extendPause(
    { pauseId: id, expiresIn: hours(5) },
    { answeredBy: "the operator" },
  );
  process.stdout.write(`result extended=${String(extension.pauseKey.length > 0)}\n`);
} else if (operation === "reassign") {
  const moved = await app.reassignPause(
    { pauseId: id, assignee: "deputy-3" },
    { answeredBy: "the operator" },
  );
  process.stdout.write(`result reassigned=${String(moved.pauseKey.length > 0)}\n`);
} else if (operation === "cancel") {
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
