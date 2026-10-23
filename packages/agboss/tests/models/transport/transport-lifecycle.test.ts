/**
 * #385 S4 — a transport provider created on its first call runs its lifecycle like any component:
 * `onInit` → `onStart` before its first `complete()`, once under concurrent first calls; a failing
 * hook fails that call (the start's error) and the next call tries again; `app.close()` runs
 * `onStop` / `onDestroy` only for a transport that was created.
 */
import { describe, expect, it } from "vitest";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "./bedrock-provider.fixture.js";
import { LifecycleApplication, LifecycleLog } from "./lifecycle.fixture.js";
import { transportApp } from "./transport-app.js";

/** An instance of the lifecycle application over its own log. */
async function lifecycleApp(log: LifecycleLog) {
  const client = new ScriptedBedrockClient([]);
  return transportApp(LifecycleApplication, { client, overrides: new Map([[LifecycleLog, log]]) });
}

describe("#385 S4: a lazily created transport provider runs its lifecycle hooks", () => {
  it("on its first call: onInit, then onStart, awaited before its first complete()", async () => {
    const log = new LifecycleLog();
    const app = await lifecycleApp(log);

    expect(log.entries).toEqual([]);
    await execute(app, ChatStart, { text: "one" });
    await execute(app, ChatStart, { text: "two" });

    expect(log.entries).toEqual([
      "onInit",
      "onStart",
      "complete bedrock/claude",
      "complete bedrock/claude",
    ]);
    await app.close();
  });

  it("concurrent first calls create and start it once", async () => {
    const log = new LifecycleLog();
    const app = await lifecycleApp(log);

    await Promise.all([
      execute(app, ChatStart, { text: "one" }),
      execute(app, ChatStart, { text: "two" }),
      execute(app, ChatStart, { text: "three" }),
    ]);

    expect(log.entries.filter((entry) => entry === "onInit")).toHaveLength(1);
    expect(log.entries.filter((entry) => entry === "onStart")).toHaveLength(1);
    expect(log.entries.filter((entry) => entry.startsWith("complete"))).toHaveLength(3);
    await app.close();
  });

  it("a failing onStart fails that call with the start's error; the next call tries again", async () => {
    const log = new LifecycleLog();
    log.failures.starts = 1;
    const app = await lifecycleApp(log);

    const failed = await execute(app, ChatStart, { text: "one" }).catch((error: unknown) => error);
    const result = await execute(app, ChatStart, { text: "two" });

    expect(String(causesOf(failed))).toContain(
      "[di.hook-failed] LifecycleModelProvider.onStart failed: the SDK session could not be opened",
    );
    expect(result.output).toEqual({ text: "ok" });
    expect(log.entries).toEqual([
      "onInit",
      "onStart",
      "onDestroy",
      "onInit",
      "onStart",
      "complete bedrock/claude",
    ]);
    await app.close();
  });

  it("app.close() runs onStop and onDestroy for a created transport; one never called gets none", async () => {
    const used = new LifecycleLog();
    const unused = new LifecycleLog();
    const usedApp = await lifecycleApp(used);
    const unusedApp = await lifecycleApp(unused);

    await execute(usedApp, ChatStart, { text: "one" });
    await Promise.all([usedApp.close(), unusedApp.close()]);

    expect(used.entries.slice(-2)).toEqual(["onStop", "onDestroy"]);
    expect(unused.entries).toEqual([]);
  });
});

/** The messages of an error and its causes, outermost first. */
function causesOf(error: unknown): string[] {
  const messages: string[] = [];
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
    messages.push(cause.message);
  return messages;
}
