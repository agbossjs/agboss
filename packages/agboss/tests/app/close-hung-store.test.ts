/**
 * #923 AC3 — `app.close()` ends within its shutdown timeout while a store call is never answered:
 * the recovery sweep and the child workers each wait on a store (the records' look at the running
 * executions, the queue's claim); a call that never returns must not hold the stop, which gives
 * them up at its end (the shutdown timeout) and says so in the log.
 */
import { beforeEach, describe, expect } from "vitest";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { logged, resetLogged } from "../helpers/log.js";
import { passLive } from "../helpers/live-time.js";
import { hung, HungStoreApplication, resetHung } from "./fixtures/hung-store.application.js";

const test = testWith(HungStoreApplication, { concurrency: TestConcurrency.Real });

beforeEach(() => {
  resetHung();
  resetLogged();
});

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 100));

describe("#923 AC3: close() within its timeout with a store call that never answers", () => {
  test("a child claim that never answers", async ({ app, clock }) => {
    await app.ready();
    await settle();
    hung.claim = true;
    await clock.advance(seconds(30)); // the next sweep's look claims
    await settle();
    expect(hung.calls).toBeGreaterThan(0);

    const closed = app.close();
    await passLive(clock, seconds(60));
    await closed;

    expect(logged.some((entry) => entry.code === "app.stop-store-call-pending")).toBe(true);
  });

  test("a recovery look at the running executions that never answers", async ({ app, clock }) => {
    await app.ready();
    await settle();
    hung.records = true;
    await clock.advance(seconds(30)); // the next sweep asks the records store
    await settle();
    expect(hung.calls).toBeGreaterThan(0);

    const closed = app.close();
    await passLive(clock, seconds(60));
    await closed;

    expect(logged.some((entry) => entry.code === "app.stop-store-call-pending")).toBe(true);
  });
});
