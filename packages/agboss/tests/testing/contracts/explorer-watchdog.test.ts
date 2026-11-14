/**
 * #1061 (#928) — the explorer's watchdog fails a hung action with that action's own description,
 * also when quicker actions ran before it or run beside it while the loop is already looking.
 */
import { describe, expect, it } from "vitest";
import { waitOf } from "../../../src/infrastructure/clock.js";
import { ActionWatchdog } from "../../../src/testing/contracts/explorer/action-watchdog.js";

const never = (): Promise<string> => new Promise<string>(() => undefined);
const messageOf = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "answered",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("#1061: the watchdog names the action that hung", () => {
  it("a hung action that follows a quick one fails as itself", async () => {
    const dog = new ActionWatchdog();
    await dog.watch(Promise.resolve("ok"), waitOf(100), () => new Error("first action"));

    const hung = dog.watch(never(), waitOf(100), () => new Error("second action"));

    expect(await messageOf(hung)).toBe("second action");
  });

  it("each of several hung actions in flight together fails with its own description", async () => {
    const dog = new ActionWatchdog();
    const quick = dog.watch(Promise.resolve("ok"), waitOf(100), () => new Error("quick action"));
    const hung = ["a", "b", "c"].map((name) =>
      messageOf(dog.watch(never(), waitOf(100), () => new Error(`hung ${name}`))),
    );

    expect(await quick).toBe("ok");
    expect(await Promise.all(hung)).toEqual(["hung a", "hung b", "hung c"]);
  });
});
