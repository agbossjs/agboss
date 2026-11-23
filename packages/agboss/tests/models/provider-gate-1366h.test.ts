/**
 * #1366: one provider's rate-limit gate — what it keeps in the shared repository (the slot, the
 * calls and tokens windows and the 429 pause under the provider's keys, and only the ones its policy
 * sets), that a full window or a full slot keeps a call waiting without spending the window's calls,
 * that the released tokens are counted once and only when the policy limits tokens, that a 429 halves
 * the allowed calls once per pause and wakes the queue, that a failing store fails every waiter with
 * its error, that a call that left the queue gives its slot back, that the wake timer is stopped
 * when nobody waits or a new one replaces it, and how many calls of a tenant are in flight.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  InMemoryRateLimitRepository,
  type RateLimitLease,
} from "../../src/infrastructure/rate-limit.repository.js";
import { ProviderGate } from "../../src/models/calls/provider-gate.js";
import type { GatePass } from "../../src/models/calls/gate-pass.js";
import {
  QueueBalancingStrategy,
  RateLimitPolicy,
} from "../../src/models/policies/rate-limit-policy.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds, type Milliseconds } from "../../src/units/index.js";

const application = applicationContextOf({
  name: "provider-gate-1366h",
  version: "1.0.0",
  instanceId: "instance-1",
  startedAt: new Date(0),
  environmentName: "test",
  environment: NO_ENVIRONMENT_VALUES,
});

/** The clock, with the signal of every sleep (a timer not stopped stays unaborted). */
class SpyClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];
  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

/** The repository, with every window call and release recorded and failures / delays on demand. */
class SpyRepository extends InMemoryRateLimitRepository {
  readonly windowCalls: { readonly key: string; readonly amount: number }[] = [];
  readonly releases: RateLimitLease[] = [];
  failure: Error | undefined;
  holdTokenReads: Promise<void> | undefined;

  override pausedUntil(key: string): Promise<Date | undefined> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return super.pausedUntil(key);
  }

  override async addToWindow(
    key: string,
    amount: number,
    window: Milliseconds,
    limit?: number,
  ): Promise<number | undefined> {
    this.windowCalls.push({ key, amount });
    if (this.holdTokenReads !== undefined && key.endsWith("tokens-per-minute")) {
      await this.holdTokenReads;
    }
    return await super.addToWindow(key, amount, window, limit);
  }

  override release(lease: RateLimitLease): Promise<void> {
    this.releases.push(lease);
    return super.release(lease);
  }
}

function gateOf(options: Parameters<typeof RateLimitPolicy.of>[0]) {
  const clock = new SpyClock(new Date("2026-01-01T00:00:00.000Z"));
  const database = new InMemoryDatabase();
  const repository = new SpyRepository(clock, application, database);
  const gate = new ProviderGate({
    provider: "p",
    policy: RateLimitPolicy.of(options),
    rateLimits: repository,
    clock,
  });
  return { gate, clock, database, repository };
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5));

interface Watched {
  pass: GatePass | undefined;
  error: unknown;
  readonly done: Promise<void>;
}

/** A call entering the gate, watched: its pass once let in, or the error that failed it. */
function enter(gate: ProviderGate, tenantId = "t", signal?: AbortSignal): Watched {
  const watched: Watched = {
    pass: undefined,
    error: undefined,
    done: Promise.resolve(),
  };
  const done = gate.enter({ tenantId, weight: 1, signal }).then(
    (pass) => {
      watched.pass = pass;
    },
    (error: unknown) => {
      watched.error = error;
    },
  );
  return Object.assign(watched, { done });
}

const entered = async (gate: ProviderGate, tenantId = "t"): Promise<GatePass> => {
  const call = enter(gate, tenantId);
  await call.done;
  if (call.pass === undefined) throw new Error("not let in", { cause: call.error });
  return call.pass;
};

const total = (entries: readonly { readonly amount: number }[] | undefined): number =>
  (entries ?? []).reduce((sum, entry) => sum + entry.amount, 0);

describe("#1366: what the gate keeps in the shared repository", () => {
  it("a slot, a call and the tokens under the provider's keys, and the pause under its cooldown key", async () => {
    const { gate, clock, database } = gateOf({
      maxConcurrentCalls: 2,
      perMinute: { calls: 10, tokens: 100 },
    });

    const pass = await entered(gate);
    expect(database.rateLimitSlots.get("p:slots")).toHaveLength(1);
    expect(total(database.rateLimitWindows.get("p:calls-per-minute"))).toBe(1);

    await pass.release(40);
    expect(total(database.rateLimitWindows.get("p:tokens-per-minute"))).toBe(40);
    expect(database.rateLimitSlots.get("p:slots")).toHaveLength(0);

    await gate.slowDown(seconds(10));
    expect(database.rateLimitPauses.get("p:cooldown")?.getTime()).toBe(
      clock.now().getTime() + seconds(10),
    );
  });

  it("a policy without max concurrent calls keeps no slot and allows an unlimited number now", async () => {
    const { gate, database } = gateOf({ perMinute: { tokens: 100 } });

    const pass = await entered(gate);

    expect(gate.allowedNow()).toBe(Number.POSITIVE_INFINITY);
    expect(database.rateLimitSlots.has("p:slots")).toBe(false);
    expect(database.rateLimitWindows.has("p:calls-per-minute")).toBe(false);
    await pass.release(0);
  });

  it("a policy without a tokens limit counts no tokens, one with a limit counts none for zero tokens", async () => {
    const calls = gateOf({ perMinute: { calls: 5 } });
    const callsPass = await entered(calls.gate);
    await callsPass.release(50);
    expect(calls.database.rateLimitWindows.has("p:tokens-per-minute")).toBe(false);
    expect(calls.repository.windowCalls.every((call) => call.key !== "p:tokens-per-minute")).toBe(
      true,
    );

    const limited = gateOf({ perMinute: { tokens: 100 } });
    const limitedPass = await entered(limited.gate);
    const readsBefore = limited.repository.windowCalls.length;
    await limitedPass.release(0);
    expect(limited.repository.windowCalls).toHaveLength(readsBefore);
  });
});

describe("#1366: a full window or slot keeps a call waiting", () => {
  it("the tokens used up in the window keep the next call out until the window passes", async () => {
    const { gate, clock } = gateOf({ perMinute: { tokens: 100 } });
    const first = await entered(gate);
    await first.release(100);

    const second = enter(gate);
    await tick();
    expect(second.pass).toBeUndefined();

    await clock.advance(minutes(1));
    await tick();
    expect(second.pass).toBeDefined();
  });

  it("a slot held elsewhere does not spend the window's calls while the call waits for it", async () => {
    const { gate, clock, database, repository } = gateOf({
      maxConcurrentCalls: 1,
      perMinute: { calls: 3 },
    });
    const elsewhere = await repository.acquire("p:slots", 1, minutes(5));
    const waiting = enter(gate);
    await tick();

    await clock.advance(seconds(2));
    await tick();
    expect(waiting.pass).toBeUndefined();
    expect(total(database.rateLimitWindows.get("p:calls-per-minute"))).toBe(0);

    if (elsewhere !== undefined) await repository.release(elsewhere);
    await clock.advance(seconds(1));
    await tick();

    expect(waiting.pass).toBeDefined();
    expect(total(database.rateLimitWindows.get("p:calls-per-minute"))).toBe(1);
  });
});

describe("#1366: a failing store fails every waiter with its error", () => {
  it("two waiting tenants both get the store's error", async () => {
    const { gate, repository } = gateOf({ maxConcurrentCalls: 1 });
    repository.failure = new Error("store down");

    const a = enter(gate, "a");
    const b = enter(gate, "b");
    await Promise.all([a.done, b.done]);

    expect(a.error).toBe(repository.failure);
    expect(b.error).toBe(repository.failure);
  });
});

describe("#1366: a 429 slows the gate down", () => {
  it("halves the allowed calls once per pause: a second 429 right when the pause ends halves again", async () => {
    const { gate, clock } = gateOf({ maxConcurrentCalls: 8 });

    await gate.slowDown(seconds(1));
    expect(gate.allowedNow()).toBe(4);
    await clock.advance(seconds(1));
    expect(gate.allowedNow()).toBe(4);

    await gate.slowDown(seconds(1));

    expect(gate.allowedNow()).toBe(2);
  });

  it("a 429 whose pause is already over wakes a waiter at once, without waiting for the poll", async () => {
    const { gate, repository } = gateOf({ maxConcurrentCalls: 1 });
    const elsewhere = await repository.acquire("p:slots", 1, minutes(1));
    const waiting = enter(gate);
    await tick();
    expect(waiting.pass).toBeUndefined();

    if (elsewhere !== undefined) await repository.release(elsewhere);
    await gate.slowDown(seconds(0));
    await tick();

    expect(waiting.pass).toBeDefined();
  });
});

describe("#1366: the wake timer of a waiting queue", () => {
  it("is replaced by a new one and stopped when nobody waits", async () => {
    const { gate, clock, repository } = gateOf({ maxConcurrentCalls: 1 });
    await repository.acquire("p:slots", 1, minutes(1));
    const abort = new AbortController();
    const waiting = enter(gate, "t", abort.signal);
    await tick();
    const polling = clock.signals.filter((signal) => signal !== undefined);
    expect(polling).toHaveLength(1);

    await gate.slowDown(seconds(10));
    await tick();
    expect(polling[0]?.aborted).toBe(true);

    abort.abort(new Error("cancelled"));
    await waiting.done;
    await tick();

    expect(waiting.error).toBeInstanceOf(Error);
    expect(clock.signals.every((signal) => signal?.aborted === true)).toBe(true);
  });
});

describe("#1366: a call that left the queue while its room was being checked", () => {
  it("without a slot gives nothing back", async () => {
    const { gate, repository } = gateOf({ perMinute: { tokens: 100 } });
    let open: () => void = () => undefined;
    repository.holdTokenReads = new Promise<void>((resolve) => {
      open = resolve;
    });
    const abort = new AbortController();
    const leaving = enter(gate, "t", abort.signal);
    await tick();

    abort.abort(new Error("left"));
    open();
    await leaving.done;
    await tick();

    expect(repository.releases).toHaveLength(0);
  });

  it("with a slot gives it back", async () => {
    const { gate, repository, database } = gateOf({
      maxConcurrentCalls: 1,
      perMinute: { tokens: 100 },
    });
    let open: () => void = () => undefined;
    repository.holdTokenReads = new Promise<void>((resolve) => {
      open = resolve;
    });
    const abort = new AbortController();
    const leaving = enter(gate, "t", abort.signal);
    await tick();

    abort.abort(new Error("left"));
    open();
    await leaving.done;
    await tick();

    expect(database.rateLimitSlots.get("p:slots") ?? []).toHaveLength(0);
  });
});

describe("#1366: the calls of a tenant in flight decide the next one under least-in-flight", () => {
  const policy = (max: number) => ({
    maxConcurrentCalls: max,
    balancing: QueueBalancingStrategy.TenantLeastInFlight,
  });

  it("a tenant whose only call ended has none in flight: it is served before one with a call", async () => {
    const { gate } = gateOf(policy(2));
    const a1 = await entered(gate, "a");
    await entered(gate, "b");
    const order: string[] = [];
    const b2 = enter(gate, "b");
    const a2 = enter(gate, "a");
    void b2.done.then(() => order.push("b"));
    void a2.done.then(() => order.push("a"));
    await tick();

    await a1.release(0);
    await tick();

    expect(order).toEqual(["a"]);
  });

  it("a tenant with two calls in flight that ended one has one: it is served before one with two", async () => {
    const { gate } = gateOf(policy(4));
    const a1 = await entered(gate, "a");
    await entered(gate, "a");
    await entered(gate, "b");
    await entered(gate, "b");
    const order: string[] = [];
    const b3 = enter(gate, "b");
    const a3 = enter(gate, "a");
    void b3.done.then(() => order.push("b"));
    void a3.done.then(() => order.push("a"));
    await tick();

    await a1.release(0);
    await tick();

    expect(order).toEqual(["a"]);
  });
});
