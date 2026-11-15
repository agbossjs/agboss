/**
 * #941 (an instance stopping): `app.close()` interrupts an expiry look that waits for its channel's
 * handler — the instance's stop is no expiry decision: nothing is recorded, the lease is released,
 * the pause stays pending, and another instance's look finishes it (its handler asked again).
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ApplicationContext, PauseResolution } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  ShortExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication, { instances: 2 });

beforeEach(resetExpiry);

describe("#941: an instance that stops while its look waits for the channel", () => {
  test("no decision is recorded; the other instance's look expires the pause", async ({
    apps,
    clock,
  }) => {
    const [first, second] = apps;
    if (first === undefined || second === undefined) throw new Error("two instances");
    await first.ready();
    await second.ready();
    const paused = await execute(
      first,
      ShortExpiryWorkflowStart,
      { orderId: "o-1" },
      {
        threadId: "close-1",
      },
    );
    let calls = 0;
    expiry.behavior = () => {
      calls += 1;
      // the first handler hangs; the second answers
      return calls === 1
        ? new Promise<never>(() => undefined)
        : PauseExpiration.decide({ approved: true, comment: "second" });
    };

    await clock.advance(hours(4));
    await until(() => expiry.asked.length === 1);
    const holder = expiry.holders[0];
    const stopping = [first, second].find(
      (app) => app.resolve(ApplicationContext).instanceId === holder,
    );
    // the stop waits for its executions up to its shutdown timeout, then interrupts what still runs
    const closing = stopping?.close();
    await clock.advance(minutes(1));
    await closing;

    await until(() => expiry.ended.length === 1);

    expect(expiry.asked).toHaveLength(2);
    expect(expiry.recorded).toEqual(["o-1: approved (second)"]);
    const [done] = await expiryStore().findAllByTenantIdAndRootExecutionId(
      "default",
      paused.executionId,
    );
    expect(done?.resolution).toBe(PauseResolution.DecidedOnExpiry);
  });
});

describe("#941: app.close waits for the expiries in flight", () => {
  const single = testWith(ExpiryApplication);

  single(
    "close resolves only once the handler of an expiry under way has returned",
    async ({ app, clock }) => {
      await app.ready();
      await execute(app, ShortExpiryWorkflowStart, { orderId: "o-1" }, { threadId: "close-2" });
      let release: () => void = () => undefined;
      expiry.behavior = async () => {
        // a handler that does not look at the stop: only its own end ends the expiry
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return PauseExpiration.decide({ approved: true, comment: "late" });
      };
      await clock.advance(hours(4));
      await until(() => expiry.asked.length === 1);

      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      for (let turn = 0; turn < 20; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));

      expect(closed).toBe(false);
      release();
      await closing;
      expect(closed).toBe(true);
      // nothing starts after the close: what ran, ran before it resolved
      const ranByClose = [...expiry.recorded];
      await clock.advance(minutes(1));
      await new Promise((resolve) => setImmediate(resolve));
      expect(expiry.recorded).toEqual(ranByClose);
      expect(expiry.asked).toHaveLength(1);
    },
  );
});
