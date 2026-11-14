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
