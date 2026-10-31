/**
 * #533 item 3 — the held lease, move by move, on the in-memory lease store with its timers held at
 * a closed gate (no background renewal or expiry: each move is the test's): what a lost or released
 * holder still asks its store, which renewals run the after-renewal checks, what a yield and a
 * reclaim leave behind — the holder a fenced write stops, the token a hand-over names, the fence's
 * deadline — and that a release wakes the calls waiting for the tree once.
 */
import { describe, expect, it } from "vitest";
import {
  executionLeasesOf,
  type HeldExecutionLease,
  type LeaseEventLog,
} from "../../src/app/execution-leases.js";
import { handedOverOf } from "../../src/app/handed-over.js";
import type { HeldLease } from "../../src/app/held-lease.js";
import { leaseReleases } from "../../src/app/lease-releases.js";
import { ExecutionObserverManager } from "../../src/core/observer-manager.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { nodeEventOf } from "../../src/flow/observers/execution-event.js";
import {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  type ExecutionLease,
} from "../../src/index.js";
import {
  ExecutionLeaseEventKind,
  HandOverSite,
  InMemoryExecutionLeaseEventRepository,
} from "../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase, treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { LeaseGate } from "../../src/testing/leases.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { recordingLog } from "../helpers/log.js";

const TREE = { tenantId: "acme", rootExecutionId: "root-1" };
const SCOPE = "acme:root-1";

/** What the scripted store does on its next calls, and how many of each reached it. */
interface StoreScript {
  renewFails: boolean;
  renewGate: Promise<void> | undefined;
  yieldAnswer: "store" | "rejects" | false;
  reclaimGate: Promise<void> | undefined;
  readonly calls: { renew: number; yield: number };
}

/** The in-memory lease store with its renewals, yields and reclaims scripted by the test. */
class ScriptedLeaseRepository extends InMemoryExecutionLeaseRepository {
  readonly script: StoreScript = {
    renewFails: false,
    renewGate: undefined,
    yieldAnswer: "store",
    reclaimGate: undefined,
    calls: { renew: 0, yield: 0 },
  };

  override async renew(lease: ExecutionLease, duration: Milliseconds) {
    this.script.calls.renew += 1;
    await this.script.renewGate;
    if (this.script.renewFails) throw new Error("the lease store is down");
    return super.renew(lease, duration);
  }

  override async yield(lease: ExecutionLease): Promise<boolean> {
    this.script.calls.yield += 1;
    if (this.script.yieldAnswer === "rejects") throw new Error("the lease store is down");
    return this.script.yieldAnswer === false ? false : super.yield(lease);
  }

  override async reclaim(lease: ExecutionLease, duration: Milliseconds) {
    await this.script.reclaimGate;
    return super.reclaim(lease, duration);
  }
}

/** A gate the test opens: `passed` until `open()`. */
function closedGate(): { readonly passed: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    passed,
    open: () => {
      open();
    },
  };
}

function scriptedStore() {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "held-lease-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const store = new ScriptedLeaseRepository(clock, application, database);
  return { clock, database, store, script: store.script };
}

/** A lease the test holds, its timers at a closed gate; `events` when it keeps a lease log. */
async function heldBy(
  { clock, store }: ReturnType<typeof scriptedStore>,
  events?: Parameters<typeof executionLeasesOf>[2],
): Promise<HeldExecutionLease> {
  const gate = new LeaseGate();
  gate.close();
  return executionLeasesOf(store, gate.clockOf(clock), events).hold(TREE);
}

const settled = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A wait for remote children the test ends. */
function heldWait(): { readonly wait: () => Promise<void>; readonly end: () => void } {
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    wait: () => ended,
    end: () => {
      end();
    },
  };
}

const fencedAt = (token: number): ExecutionFencedError =>
  new ExecutionFencedError({ scopeKey: SCOPE, token, observedToken: token + 1 });

/** Whether `promise` has settled after the event loop ran a few turns. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let isDone = false;
  const done = (): void => {
    isDone = true;
  };
  void promise.then(done, done);
  await settled();
  return isDone;
}

describe("#533: a lost or released holder asks its store nothing", () => {
  it("confirmNow() after a fenced write rejects with it; no renewal reaches the store", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const fenced = fencedAt(1);
    handedOverOf(fenced, undefined);

    await expect(lease.confirmNow()).rejects.toBe(fenced);

    expect(leases.script.calls.renew).toBe(0);
    await lease.release();
  });

  it("renewNow() after a fenced write rejects with it; no renewal reaches the store", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const fenced = fencedAt(1);
    handedOverOf(fenced, undefined);

    await expect(lease.renewNow()).rejects.toBe(fenced);

    expect(leases.script.calls.renew).toBe(0);
    await lease.release();
  });

  it("confirmNow() after the release is a hand-over; no renewal reaches the store", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    await lease.release();

    await expect(lease.confirmNow()).rejects.toBeInstanceOf(ExecutionLeaseLostError);

    expect(leases.script.calls.renew).toBe(0);
  });

  it("renewNow() after the release asks the store nothing and runs the after-renewal checks", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const checks: string[] = [];
    lease.afterEachRenewal(() => {
      checks.push("checked");
      return Promise.resolve();
    });
    await lease.release();

    await expect(lease.renewNow()).resolves.toBeUndefined();

    expect(leases.script.calls.renew).toBe(0);
    expect(checks).toEqual(["checked"]);
  });

  it("the token reads undefined once the lease is released", async () => {
    const lease = await heldBy(scriptedStore());

    await lease.release();

    expect(lease.token).toBeUndefined();
  });
});

describe("#533: which renewals run the after-renewal checks", () => {
  it("a confirmed renewal runs them once; a renewal the store did not answer, within the lease, none and no loss", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const checks: string[] = [];
    lease.afterEachRenewal(() => {
      checks.push("checked");
      return Promise.resolve();
    });

    await lease.renewNow();
    const afterConfirmed = [...checks];
    leases.script.renewFails = true;
    await lease.renewNow();

    expect(afterConfirmed).toEqual(["checked"]);
    expect(checks).toEqual(["checked"]);
    expect(leases.script.calls.renew).toBe(2);
    expect(lease.signal.aborted).toBe(false);
    await lease.release();
  });

  it("a renewal answered after the release runs no checks and does not reject", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const checks: string[] = [];
    lease.afterEachRenewal(() => {
      checks.push("checked");
      return Promise.resolve();
    });
    const gate = closedGate();
    leases.script.renewGate = gate.passed;
    const renewal = lease.renewNow();

    await lease.release();
    gate.open();

    await expect(renewal).resolves.toBeUndefined();
    expect(checks).toEqual([]);
  });

  it("confirmNow() on a renewal the store did not answer rejects, though the lease has time left", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    leases.script.renewFails = true;

    await expect(lease.confirmNow()).rejects.toBeInstanceOf(ExecutionLeaseLostError);

    expect(lease.signal.aborted).toBe(true);
    await lease.release();
  });
});

describe("#533: a release, and what it leaves behind", () => {
  it("wakes the calls waiting for the tree once: a second release wakes no one", async () => {
    const lease = await heldBy(scriptedStore());
    await lease.release();
    const watch = leaseReleases.watch(treeKeyOf(TREE.tenantId, TREE.rootExecutionId));
    const giveUp = new AbortController();
    const woken = watch.wait(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        }),
      giveUp.signal,
    );

    await lease.release();
    const isWoken = await isSettled(woken);
    giveUp.abort();
    await woken;
    watch.close();

    expect(isWoken).toBe(false);
  });

  it("a fenced write of a released lease's token stops nothing", async () => {
    const lease = await heldBy(scriptedStore());
    await lease.release();

    handedOverOf(fencedAt(1), undefined);

    expect(lease.signal.aborted).toBe(false);
  });
});

describe("#533: a yield, its store's answers, and the reclaim", () => {
  it("two callers waiting at once yield the lease in the store once", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const [first, second] = [heldWait(), heldWait()];

    const waits = [lease.yieldWhile(first.wait), lease.yieldWhile(second.wait)];
    await settled();

    expect(leases.script.calls.yield).toBe(1);
    expect(lease.isYielded).toBe(true);
    first.end();
    second.end();
    await Promise.all(waits);
    await lease.release();
  });

  it("a yielded lease is no holder for a fenced write of its token", async () => {
    const lease = await heldBy(scriptedStore());
    const { wait, end } = heldWait();
    const waiting = lease.yieldWhile(wait);
    await settled();

    handedOverOf(fencedAt(1), undefined);

    expect(lease.signal.aborted).toBe(false);
    end();
    await waiting;
    await lease.release();
  });

  it("a store error on the yield leaves the lease held: the holder goes on", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    leases.script.yieldAnswer = "rejects";
    const { wait, end } = heldWait();
    const waiting = lease.yieldWhile(wait);
    await settled();

    expect([lease.isYielded, lease.signal.aborted]).toEqual([true, false]);
    end();
    await waiting;
    expect(lease.token).toBe(2);
    await lease.release();
  });

  it("a store that answers the yield with false stops the holder", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    leases.script.yieldAnswer = false;
    const { wait, end } = heldWait();
    const waiting = lease.yieldWhile(wait);
    waiting.catch(() => undefined);
    await settled();

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBeInstanceOf(ExecutionLeaseLostError);
    end();
    await lease.release();
  });

  it("after the reclaim a fenced write of the new token stops the holder", async () => {
    const lease = await heldBy(scriptedStore());
    const { wait, end } = heldWait();
    const waiting = lease.yieldWhile(wait);
    await settled();
    end();
    await waiting;
    const fenced = fencedAt(2);

    handedOverOf(fenced, undefined);

    expect(lease.token).toBe(2);
    expect(lease.signal.reason).toBe(fenced);
    await lease.release();
  });

  it("after the reclaim the fence runs from the reclaim's answer, not the first acquire's", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const { wait, end } = heldWait();
    const waiting = lease.yieldWhile(wait);
    await settled();
    await leases.clock.advance(seconds(20));
    end();
    await waiting;

    await leases.clock.advance(seconds(15));

    expect(() => {
      lease.assertHeld();
    }).not.toThrow();
    expect(lease.confirmedUntil).toBe(leases.clock.now().getTime() + seconds(14));
    await lease.release();
  });

  it("a holder fenced while its reclaim is in flight stops with that error: its wait does not go on", async () => {
    const leases = scriptedStore();
    const lease = await heldBy(leases);
    const gate = closedGate();
    leases.script.reclaimGate = gate.passed;
    const { wait, end } = heldWait();
    const waiting = lease.yieldWhile(wait);
    waiting.catch(() => undefined);
    await settled();
    end();
    await settled();
    const fenced = fencedAt(1);

    (lease as HeldLease).fenced(fenced);
    gate.open();

    await expect(waiting).rejects.toBe(fenced);
    await lease.release();
  });

  it("after the reclaim a hand-over names the new token", async () => {
    const leases = scriptedStore();
    const { log } = recordingLog();
    const events: LeaseEventLog = {
      repository: new InMemoryExecutionLeaseEventRepository(leases.database),
      observer: new ExecutionObserverManager([]),
      mask: (event) => Promise.resolve(event),
      log,
      clock: leases.clock,
      recording: import("../../src/app/lease-events.js"),
    };
    const lease = await heldBy(leases, { events });
    const { wait, end } = heldWait();
    const waiting = lease.yieldWhile(wait);
    await settled();
    end();
    await waiting;
    const error = new ExecutionLeaseLostError(TREE.rootExecutionId);

    lease.recordHandOver?.({ event: nodeEventOf(testFrame()), error, site: HandOverSite.Step });
    await lease.release();

    const handedOver = leases.database.executionLeaseEvents.filter(
      (row) => row.kind === ExecutionLeaseEventKind.HandedOver,
    );
    expect(handedOver.map((row) => row.token)).toEqual([2]);
  });
});
