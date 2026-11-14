/**
 * #928 AC1 recoverApp — the next app of a test reuses App 1's stores as values; App 2 bounds them
 * with its own clock and log, and never nests App 1's proxy.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { StoreCallTimeoutError } from "../../src/index.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import { targetOf } from "../../src/app/store-call-bound.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import {
  held,
  instances,
  resetRecover,
  RecoverBoundApplication,
} from "./fixtures/recover-bound.application.js";

const test = testWith(RecoverBoundApplication);

beforeEach(resetRecover);
afterEach(() => {
  held.records = false;
});

const timeouts = (entries: readonly { code: string }[]): number =>
  entries.filter((entry) => entry.code === "store.call-timeout").length;

describe("#928 AC1 recoverApp: the reused stores are bounded by App 2", () => {
  test("App 2 after recoverApp() bounds the reused stores with its own clock and log (a hold in App 2 fires on App 2's VirtualClock); App 1's proxy is not nested", async ({
    app,
    recoverApp,
    clock,
  }) => {
    await app.ready();
    const restarted = await recoverApp();
    await restarted.ready();
    const [first, second] = instances;
    if (first === undefined || second === undefined) throw new Error("two instances resolved");

    // the same record store behind two proxies: App 2 unwrapped App 1's and wrapped it itself
    expect(second.records).not.toBe(first.records);
    expect(targetOf(second.records)).toBe(targetOf(first.records));
    expect(targetOf(second.records)).not.toBe(second.records);
    expect(targetOf(targetOf(second.records))).toBe(targetOf(second.records));

    const before = timeouts(second.entries);
    const firstBefore = timeouts(first.entries);
    held.records = true;
    const look = second.records.findByStatus(ExecutionRecordStatus.Running, 10);
    const outcome = look.then(
      () => undefined,
      (error: unknown) => error,
    );
    await clock.advance(seconds(15));
    const error = await outcome;

    expect(error).toBeInstanceOf(StoreCallTimeoutError);
    expect(error).toMatchObject({ operation: "findByStatus" });
    expect(timeouts(second.entries)).toBeGreaterThan(before);
    // App 1's log (its app is closed) hears nothing of App 2's call
    expect(timeouts(first.entries)).toBe(firstBefore);
  });
});
