/**
 * #533 item 3 — the in-memory lease and outbound-call stores at their edges, read in their rows:
 * a yield marks the held row yielded (and a yield of a lease not held marks nothing); a take of a
 * key with no stored lease names no previous holder; an outbound call's write raises the scope's
 * mark like a fenced effect's; an attempt ends once; an intent that ended exactly at the sweep's
 * cutoff is kept; `ping()` resolves.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  InMemoryExecutionLeaseRepository,
  takenOverFromOf,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase, treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import {
  InMemoryOutboundCallRepository,
  OutboundCallStatus,
} from "../../src/infrastructure/outbound-call.repository.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { intentOf } from "../../src/testing/contracts/outbound-call-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, seconds } from "../../src/units/index.js";

/** One instance's lease and outbound-call stores over a new database. */
function storesOn() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "store-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const calls = new InMemoryOutboundCallRepository(clock, database, leases);
  return { clock, database, leases, calls };
}

async function heldIn({ leases }: ReturnType<typeof storesOn>, executionId = "execution-1") {
  const lease = await leases.acquire("default", executionId, hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  return lease;
}

const ROW = treeKeyOf("default", "execution-1");

describe("#533: the in-memory lease store", () => {
  it("a yield marks the held lease's row yielded, still its holder's", async () => {
    const stores = storesOn();
    const lease = await heldIn(stores);

    await expect(stores.leases.yield(lease)).resolves.toBe(true);

    expect(stores.database.executionLeases.get(ROW)).toMatchObject({
      released: false,
      isYielded: true,
      lease: { leaseEpoch: 1 },
    });
  });

  it("a yield of a lease no longer held marks nothing", async () => {
    const stores = storesOn();
    const lease = await heldIn(stores);
    await stores.leases.release(lease);

    await expect(stores.leases.yield(lease)).resolves.toBe(false);

    expect(stores.database.executionLeases.get(ROW)?.isYielded).toBeUndefined();
  });

  it("a take with no stored lease names no previous holder, whatever the expiry says", () => {
    expect(takenOverFromOf(undefined, true)).toEqual({});
  });

  it("ping() resolves", async () => {
    await expect(storesOn().leases.ping()).resolves.toBeUndefined();
  });
});

describe("#533: the in-memory outbound-call store", () => {
  it("recording an intent raises the scope's mark to its token", async () => {
    const stores = storesOn();
    const key = keyOf(await heldIn(stores));

    await stores.calls.saveIfAbsent(key, intentOf(key));

    expect(stores.database.fencedEffectMarks.get(key.scopeKey)?.highestToken).toBe(1);
  });

  it("an attempt ends once: its owner cannot end it again", async () => {
    const stores = storesOn();
    const key = keyOf(await heldIn(stores));
    await stores.calls.saveIfAbsent(key, intentOf(key));
    await stores.calls.markCompleted(key, "owner-1", '{"chargeId":"ch-1"}');

    const again = await stores.calls.markFailed(key, "owner-1", {
      name: "Error",
      code: "Error",
      message: "late",
    });

    expect(again).toBe(false);
    expect(await stores.calls.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Completed,
      result: '{"chargeId":"ch-1"}',
    });
  });

  it("an intent that ended exactly at the sweep's cutoff is kept; one before it goes", async () => {
    const stores = storesOn();
    const [early, late] = [keyOf(await heldIn(stores)), keyOf(await heldIn(stores, "execution-2"))];
    await stores.calls.saveIfAbsent(early, intentOf(early));
    await stores.calls.markCompleted(early, "owner-1", "{}");
    await stores.clock.advance(seconds(1));
    await stores.calls.saveIfAbsent(late, intentOf(late));
    await stores.calls.markCompleted(late, "owner-1", "{}");

    await stores.calls.deleteByEndedAtBefore(stores.clock.now());

    expect(await stores.calls.findByKey(early)).toBeUndefined();
    expect(await stores.calls.findByKey(late)).toMatchObject({
      status: OutboundCallStatus.Completed,
    });
  });

  it("ping() resolves", async () => {
    await expect(storesOn().calls.ping()).resolves.toBeUndefined();
  });
});
