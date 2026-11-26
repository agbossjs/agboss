/**
 * #1310a / #1307d: a target's `onExpired` may hand the pause on — `PauseExpiration.reassign({ assignees,
 * timeout?, reason? })`. A pause that stays with its target and channel changes in place by the
 * store's due-at compare-and-set (same id, same `externalRef`, a `reassigned` entry, a new deadline),
 * the tree resting paused all the while; a bad request, or a deadline already past, expires the
 * pause as `fail()`.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ExecutionStatus, PauseResolution, PauseStatus } from "../../src/index.js";
import { ExpiryProblem, NO_RECIPIENTS } from "../../src/infrastructure/pause-record.js";
import { seenOf } from "../../src/infrastructure/pause-seen.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication);

beforeEach(resetExpiry);

describe("#1310a: an expiry reassigns the pause", () => {
  test("the pause waits on for the assignees under a new deadline, in place, the tree rests paused", async ({
    app,
    clock,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      { threadId: "re-1" },
    );
    let calls = 0;
    expiry.behavior = () => {
      calls += 1;
      return calls === 1
        ? PauseExpiration.reassign({
            assignees: ["deputy-1", "deputy-2"],
            timeout: hours(2),
            reason: "no answer in a day",
          })
        : PauseExpiration.fail();
    };

    await clock.advance(hours(24));
    await until(() => calls > 0);
    await clock.advance(minutes(1));

    const pauses = await expiryStore().findAllByTenantIdAndRootExecutionId(
      "default",
      paused.executionId,
    );
    // in place: no second pause, the same id
    expect(pauses).toHaveLength(1);
    const [next] = pauses;
    expect(next).toMatchObject({
      pauseId: expiry.sent[0]?.pauseId,
      status: PauseStatus.Pending,
      assignees: ["deputy-1", "deputy-2"],
    });
    expect(next?.reassignedFrom).toBeUndefined();
    expect(Date.parse(next?.expiresAt ?? "") - clock.now().getTime()).toBeLessThanOrEqual(hours(2));
    expect(next?.remindAt).toBeUndefined();
    expect(next?.trail.map((entry) => entry.action)).toEqual(["opened", "reassigned"]);
    expect(next?.trail[1]).toMatchObject({
      assignees: ["deputy-1", "deputy-2"],
      reason: "no answer in a day",
    });
    // its channel is not asked again: nothing was made
    expect(expiry.sent).toHaveLength(1);
    // the handler was asked once: the pause's deadline is two hours away
    expect(calls).toBe(1);
    expect(expiry.errors).toEqual([]);
    const again = await app.resume(
      { pauseId: expiry.sent[0]?.pauseId ?? "", decision: { approved: true } },
      { actor: { id: "deputy-1" } },
    );
    expect(again.status).toBe(ExecutionStatus.Finished);
  });

  test("a chain with no maxTotalTimeout hands onExpired no maxExpiresAt", async ({
    app,
    clock,
  }) => {
    await execute(app, ExpiryWorkflowStart, { orderId: "o-3" }, { threadId: "re-3" });

    await clock.advance(hours(24));
    await until(() => expiry.asked.length === 1);

    expect(expiry.asked[0]).not.toHaveProperty("maxExpiresAt");
  });

  test("a request that is no valid reassignment expires the pause as fail(), the problem kept", async ({
    app,
    clock,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-2" },
      { threadId: "re-2" },
    );
    expiry.behavior = () => PauseExpiration.reassign({ assignees: ["d-1"], timeout: 5 as never });

    await clock.advance(hours(24));
    await until(() => expiry.asked.length === 1);
    const readPauses = () =>
      expiryStore().findAllByTenantIdAndRootExecutionId("default", paused.executionId);
    await until(() => expiry.sent.length >= 1);
    await clock.advance(minutes(1));

    const all = await readPauses();
    const first = all.find((one) => one.expiryProblem !== undefined);
    expect(first).toMatchObject({
      resolution: PauseResolution.Expired,
      expiryProblem: ExpiryProblem.AnswerInvalid,
    });
    expect(all.some((one) => one.reassignedTo !== undefined)).toBe(false);
  });

  test("the store refuses the move while the pause is as it was planned: `failed` — it expires as fail(), not left for the next look", async ({
    app,
    clock,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-4" },
      { threadId: "re-4" },
    );
    expiry.behavior = () => PauseExpiration.reassign({ assignees: ["d-1"], timeout: hours(2) });
    vi.spyOn(expiryStore(), "reassignByTenantIdAndPauseId").mockResolvedValue(undefined);

    await clock.advance(hours(24));
    await until(() => expiry.asked.length === 1);
    await clock.advance(minutes(1));

    const [pause] = await expiryStore().findAllByTenantIdAndRootExecutionId(
      "default",
      paused.executionId,
    );
    expect(pause).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
    });
    expect(expiry.asked).toHaveLength(1);
  });

  test("the store refuses the move because another writer moved the deadline meanwhile: `lost` — the pause stays pending under that deadline", async ({
    app,
    clock,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-5" },
      { threadId: "re-5" },
    );
    const store = expiryStore();
    expiry.behavior = () => PauseExpiration.reassign({ assignees: ["d-1"], timeout: hours(2) });
    vi.spyOn(store, "reassignByTenantIdAndPauseId").mockImplementation(async (...args) => {
      const [tenantId, pauseId] = args;
      const before = await store.findByTenantIdAndPauseId(tenantId, pauseId);
      if (before === undefined) throw new Error("the pause is gone");
      // an operator's change won the race: the same pause under a deadline a day later
      await store.changeTimeoutByTenantIdAndPauseId(
        tenantId,
        pauseId,
        {
          seen: seenOf(before),
          expiresAt: new Date(clock.now().getTime() + hours(24)).toISOString(),
          previousExpiresAt: before.expiresAt,
        },
        new Date(Date.parse(before.expiresAt ?? "") - 1),
        NO_RECIPIENTS,
      );
      return undefined;
    });

    await clock.advance(hours(24));
    await until(() => expiry.asked.length === 1);
    await clock.advance(minutes(1));

    const [pause] = await store.findAllByTenantIdAndRootExecutionId("default", paused.executionId);
    expect(pause?.status).toBe(PauseStatus.Pending);
    expect(Date.parse(pause?.expiresAt ?? "")).toBeGreaterThan(clock.now().getTime());
    expect(pause?.resolution).toBeUndefined();
  });
});
