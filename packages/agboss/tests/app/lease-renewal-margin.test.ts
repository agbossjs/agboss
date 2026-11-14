/**
 * #534 AC3 — the framework's own renewal margin: a healthy holder renews every third of its lease,
 * so each renewal reaches the store with two thirds of the lease left — far from the boundary that
 * #534 made strict. One renewal the store does not answer still leaves a third; only a holder that
 * misses every renewal for a whole lease reaches the expiry, and that one is stopped there.
 */
import { describe, expect, it } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import { EXECUTION_LEASE, LEASE_SAFETY_MARGIN, RENEW_EVERY } from "../../src/app/lease-fence.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase, treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { type Milliseconds } from "../../src/units/index.js";
import { storeClockOf } from "../helpers/store-clock.js";

/** A lease store that records, at each renewal it is asked for, how long the lease had left. */
class MarginRecordingLeaseRepository extends InMemoryExecutionLeaseRepository {
  readonly margins: number[] = [];
  /** How many coming renewals fail as an unreachable store would. */
  failing = 0;

  constructor(
    private readonly time: VirtualClock,
    private readonly rows: InMemoryDatabase,
  ) {
    super(
      storeClockOf(time),
      applicationContextOf({
        name: "margin-application",
        version: "1.0.0",
        instanceId: "instance-1",
        startedAt: time.now(),
        environmentName: "test",
        environment: NO_ENVIRONMENT_VALUES,
      }),
      rows,
    );
  }

  override renew(lease: ExecutionLease, length: Milliseconds): Promise<Milliseconds | undefined> {
    const stored = this.rows.executionLeases.get(treeKeyOf(lease.tenantId, lease.rootExecutionId));
    if (stored !== undefined)
      this.margins.push(stored.lease.expiresAt.getTime() - this.time.now().getTime());
    if (this.failing > 0) {
      this.failing -= 1;
      return Promise.reject(new Error("the lease store does not answer"));
    }
    return super.renew(lease, length);
  }
}

/** What a renewal reaches the store with after 0, 1 and 2 missed ones: 3/4, 2/4 and 1/4 of the lease. */
const LEFT = [3, 2, 1].map((quarters) => (EXECUTION_LEASE / 4) * quarters);

const TREE = { tenantId: "default", rootExecutionId: "root-1" };

function holderOn() {
  const clock = new VirtualClock();
  const store = new MarginRecordingLeaseRepository(clock, new InMemoryDatabase());
  return { clock, store, leases: executionLeasesOf(store, clock) };
}

describe("#534 AC3: a healthy holder stays far from its lease's boundary", () => {
  it("AC3: the lease is four renewal intervals long (#928: tries at 1/4, 2/4 and 3/4 of it, inside the trust)", () => {
    expect(RENEW_EVERY * 4).toBe(EXECUTION_LEASE);
    expect(RENEW_EVERY * 3).toBeLessThan(EXECUTION_LEASE - LEASE_SAFETY_MARGIN);
  });

  it("AC3: over five minutes every renewal reaches the store with three quarters of its lease left", async () => {
    const { clock, store, leases } = holderOn();
    const holder = await leases.hold(TREE);

    for (let step = 0; step < 40; step += 1) await clock.advance(RENEW_EVERY);

    expect(store.margins).toHaveLength(40);
    expect(new Set(store.margins)).toEqual(new Set([LEFT[0]]));
    expect(holder.signal.aborted).toBe(false);
    await holder.release();
  });

  it("AC3: one renewal the store does not answer still leaves half the lease at the next; the holder goes on", async () => {
    const { clock, store, leases } = holderOn();
    const holder = await leases.hold(TREE);

    store.failing = 1;
    for (let step = 0; step < 3; step += 1) await clock.advance(RENEW_EVERY);

    expect(store.margins).toEqual([LEFT[0], LEFT[1], LEFT[0]]);
    expect(holder.signal.aborted).toBe(false);
    await holder.release();
  });

  it("#928: two renewals in a row the store does not answer still leave a quarter of the lease at the third; the holder goes on", async () => {
    const { clock, store, leases } = holderOn();
    const holder = await leases.hold(TREE);

    store.failing = 2;
    for (let step = 0; step < 4; step += 1) await clock.advance(RENEW_EVERY);

    expect(store.margins).toEqual([LEFT[0], LEFT[1], LEFT[2], LEFT[0]]);
    expect(holder.signal.aborted).toBe(false);
    await holder.release();
  });

  it("AC3, #533: a holder whose every renewal fails stops at its fence — the lease less its safety margin — before the store's expiry", async () => {
    const { clock, store, leases } = holderOn();
    const holder = await leases.hold(TREE);

    store.failing = Number.MAX_SAFE_INTEGER;
    await clock.advance((EXECUTION_LEASE - LEASE_SAFETY_MARGIN - 1) as Milliseconds);
    const isAbortedBefore = holder.signal.aborted;
    await clock.advance(1 as Milliseconds);

    expect(isAbortedBefore).toBe(false);
    expect(holder.signal.aborted).toBe(true);
    expect(holder.signal.reason).toBeInstanceOf(ExecutionLeaseLostError);
    await holder.release();
  });
});
