/**
 * #1310a / #1307d: a target's `onExpired` may hand the pause on — `PauseExpiration.reassign({ assignees,
 * timeout?, reason? })`. A pause that stays with its target and channel changes in place by the
 * store's due-at compare-and-set (same id, same `externalRef`, a `reassigned` entry, a new deadline),
 * the tree resting paused all the while; a bad request, or a deadline already past, expires the
 * pause as `fail()`.
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ExecutionStatus, PauseResolution, PauseStatus } from "../../src/index.js";
import { ExpiryProblem } from "../../src/infrastructure/pause-record.js";
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
});
