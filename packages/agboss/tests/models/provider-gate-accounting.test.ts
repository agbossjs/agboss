/**
 * #1366: what a provider's gate counts — a slot is taken for a call in flight and given back when its pass is
 * released (on every instance), a call and its tokens are counted in the minute's window, a 429 halves the calls
 * allowed once per pause and they grow back a minute at a time.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { concurrencyAt, halvedAt } from "../../src/models/calls/concurrency-level.js";
import { ProviderCalls } from "../../src/models/calls/provider-calls.js";
import { QueueBalancingStrategy, RateLimitPolicy } from "../../src/models/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";

const ticket = { tenantId: "t1", weight: 1, signal: undefined };

type Gate = NonNullable<ReturnType<ReturnType<typeof instanceCalls>["gateOf"]>>;

const gateOf = (
  clock: VirtualClock,
  policy: Parameters<typeof RateLimitPolicy.of>[0],
  database = new InMemoryDatabase(),
  instance = "instance-1",
): Gate => {
  const gate = instanceCalls(clock, database, instance).gateOf(
    "accounted-model-provider",
    RateLimitPolicy.of(policy),
  );
  if (gate === undefined) throw new Error("no gate");
  return gate;
};

/** Asks for room now: whether it was let in within `wait` of the clock's time. */
async function isAdmitted(gate: Gate, clock: VirtualClock, wait = seconds(2)): Promise<boolean> {
  let admitted = false;
  void gate.enter(ticket).then(() => {
    admitted = true;
  });
  await clock.advance(wait);
  return admitted;
}

describe("#1366: the slots of maxConcurrentCalls", () => {
  it("a call in flight holds the slot, its release gives it to the next call", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { maxConcurrentCalls: 1 });
    const first = await gate.enter(ticket);
    let second = false;
    void gate.enter(ticket).then(() => {
      second = true;
    });

    await clock.advance(seconds(5));
    expect(second).toBe(false);
    await first.release(0);
    await clock.advance(seconds(1));

    expect(second).toBe(true);
  });

  it("a pass released twice gives its slot back once", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { maxConcurrentCalls: 2 });
    const first = await gate.enter(ticket);
    await gate.enter(ticket);

    await first.release(0);
    await first.release(0);

    // one of the two slots is still held: a third call fits, a fourth does not
    expect(await isAdmitted(gate, clock)).toBe(true);
    expect(await isAdmitted(gate, clock)).toBe(false);
  });

  it("the slot a pass released is free for another instance of the application", async () => {
    const clock = new VirtualClock();
    const database = new InMemoryDatabase();
    const here = gateOf(clock, { maxConcurrentCalls: 1 }, database, "instance-1");
    const there = gateOf(clock, { maxConcurrentCalls: 1 }, database, "instance-2");
    const held = await here.enter(ticket);
    let admitted = false;
    void there.enter(ticket).then(() => {
      admitted = true;
    });

    await clock.advance(seconds(5));
    expect(admitted).toBe(false);
    await held.release(0);
    await clock.advance(seconds(2));

    expect(admitted).toBe(true);
  });

  it("a call refused by the minute's window gives the slot it looked at back at once", async () => {
    const clock = new VirtualClock();
    const database = new InMemoryDatabase();
    const counted = gateOf(clock, { maxConcurrentCalls: 1, perMinute: { calls: 1 } }, database);
    const other = gateOf(clock, { maxConcurrentCalls: 1 }, database, "instance-2");
    await (await counted.enter(ticket)).release(0);
    void counted.enter(ticket); // the window is full: it polls, taking the slot and giving it back

    await clock.advance(seconds(1));

    expect(await isAdmitted(other, clock, seconds(1))).toBe(true);
  });
});

describe("#1366: the minute's window", () => {
  it("counts each call that starts: the call past perMinute.calls waits for the minute to pass", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { perMinute: { calls: 2 } });
    await (await gate.enter(ticket)).release(0);
    await (await gate.enter(ticket)).release(0);

    expect(await isAdmitted(gate, clock, seconds(30))).toBe(false);
    await clock.advance(seconds(31));

    expect(await isAdmitted(gate, clock, seconds(1))).toBe(true);
  });

  it("counts the tokens a pass is released with: two calls that together reach perMinute.tokens close it", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { perMinute: { tokens: 20 } });
    await (await gate.enter(ticket)).release(10);
    expect(await isAdmitted(gate, clock)).toBe(true); // 10 used, 10 to go

    await (await gate.enter(ticket)).release(10);

    expect(await isAdmitted(gate, clock)).toBe(false); // 20 used
  });

  it("counts a pass's tokens once, whatever its releases", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { perMinute: { tokens: 20 } });
    const pass = await gate.enter(ticket);
    await pass.release(15);
    await pass.release(15);

    expect(await isAdmitted(gate, clock)).toBe(true); // 15 used, not 30
  });
});

describe("#1366: a 429 slows the gate down", () => {
  it("halves the calls allowed once per pause, keeps the later pause, and they grow back a minute at a time", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { maxConcurrentCalls: 8 });
    expect(gate.allowedNow()).toBe(8);

    await gate.slowDown(seconds(10));
    expect(gate.allowedNow()).toBe(4);
    await clock.advance(seconds(1));
    await gate.slowDown(seconds(2)); // inside the pause: it ends no earlier than the first
    expect(gate.allowedNow()).toBe(4);
    await clock.advance(seconds(7));
    await gate.slowDown(seconds(1)); // at 8 s, still inside the first pause: no new halving
    expect(gate.allowedNow()).toBe(4);

    await clock.advance(seconds(60));
    expect(gate.allowedNow()).toBe(5);
    await gate.slowDown(seconds(1)); // a new pause: halves what is allowed then
    expect(gate.allowedNow()).toBe(2);
  });

  it("holds the waiting calls until the pause ends", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { maxConcurrentCalls: 4 });
    await gate.slowDown(seconds(10));

    expect(await isAdmitted(gate, clock, seconds(5))).toBe(false);
    await clock.advance(seconds(6));

    expect(await isAdmitted(gate, clock, seconds(1))).toBe(true);
  });
});

describe("#1366: the level after a 429", () => {
  it("is half of what was allowed, at least one call, growing a call a minute up to the limit", () => {
    expect(concurrencyAt(4, undefined, 0)).toBe(4);
    expect(halvedAt(4, undefined, 0)).toEqual({ lowered: 2, since: 0 });
    expect(halvedAt(5, undefined, 0).lowered).toBe(2);
    expect(halvedAt(1, undefined, 0).lowered).toBe(1);
    expect(halvedAt(2, { lowered: 1, since: 0 }, 0).lowered).toBe(1);
    expect(concurrencyAt(4, { lowered: 2, since: 0 }, minutes(1))).toBe(3);
    expect(concurrencyAt(4, { lowered: 2, since: 0 }, minutes(5))).toBe(4);
  });
});

describe("#1366: the calls an instance lets in at once", () => {
  it("after a 429 are no more than it now allows, though the shared slots would let more", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { maxConcurrentCalls: 4 });
    await gate.slowDown(seconds(1)); // 2 calls allowed now
    await clock.advance(seconds(2));
    const first = await gate.enter(ticket);
    await gate.enter(ticket);

    expect(await isAdmitted(gate, clock, seconds(1))).toBe(false); // a third waits for a release
    await first.release(0);
    await clock.advance(seconds(1));
  });

  it("a release lets the waiting call in once, when it frees a place under what is allowed", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { maxConcurrentCalls: 4 });
    await gate.slowDown(seconds(1));
    await clock.advance(seconds(2));
    const first = await gate.enter(ticket);
    await gate.enter(ticket);
    let third = false;
    void gate.enter(ticket).then(() => {
      third = true;
    });
    await clock.advance(seconds(1));

    await first.release(0);
    await clock.advance(seconds(1));

    expect(third).toBe(true);
  });
});

describe("#1366: the calls in flight of each tenant", () => {
  const policy = {
    maxConcurrentCalls: 1,
    balancing: QueueBalancingStrategy.TenantLeastInFlight,
  } as const;
  const as = (tenantId: string) => ({ tenantId, weight: 1, signal: undefined });

  it("a tenant with fewer calls in flight is served first; a call that ended is no longer counted", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, policy);
    // tenant a's calls came and went; none of tenant b's did
    const holder = await gate.enter(as("c"));
    const order: string[] = [];
    void gate.enter(as("a")).then(async (pass) => {
      order.push("a");
      await pass.release(0);
    });
    void gate.enter(as("b")).then(async (pass) => {
      order.push("b");
      await pass.release(0);
    });
    await clock.advance(seconds(1));
    await holder.release(0);
    await clock.advance(seconds(2));

    // both waited with none in flight: the first come first
    expect(order).toEqual(["a", "b"]);
  });

  it("a tenant with calls in flight waits behind one with none", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, { ...policy, maxConcurrentCalls: 2 });
    const first = await gate.enter(as("a"));
    await gate.enter(as("a"));
    const order: string[] = [];
    void gate.enter(as("a")).then(() => order.push("a"));
    void gate.enter(as("b")).then(() => order.push("b"));
    await clock.advance(seconds(1));

    await first.release(0);
    await clock.advance(seconds(1));

    expect(order).toEqual(["b"]);
  });

  it("a tenant's finished calls are given back: the tenant is served by its turn again", async () => {
    const clock = new VirtualClock();
    const gate = gateOf(clock, policy);
    for (let call = 0; call < 2; call++) await (await gate.enter(as("a"))).release(0);
    await (await gate.enter(as("b"))).release(0);
    const holder = await gate.enter(as("c"));
    const order: string[] = [];
    void gate.enter(as("a")).then(async (pass) => {
      order.push("a");
      await pass.release(0);
    });
    void gate.enter(as("b")).then(async (pass) => {
      order.push("b");
      await pass.release(0);
    });
    await clock.advance(seconds(1));

    await holder.release(0);
    await clock.advance(seconds(2));

    expect(order).toEqual(["a", "b"]);
  });
});

describe("#1366: a waiter that left while its slot was taken", () => {
  it("gives the slot back: it is not held for the minute of its lease", async () => {
    const clock = new VirtualClock();
    const database = new InMemoryDatabase();
    const here = instanceCalls(clock, database, "instance-1");
    const leaving = new AbortController();
    const inner = here.rateLimits;
    const watched = new Proxy(inner, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key !== "acquire") return (value as (...rest: unknown[]) => unknown).bind(target);
        return async (...args: unknown[]) => {
          const lease: unknown = await (value as (...rest: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          );
          leaving.abort(new Error("the caller left"));
          return lease;
        };
      },
    });
    const gate = new ProviderCalls(watched, clock).gateOf(
      "left-model-provider",
      RateLimitPolicy.of({ maxConcurrentCalls: 1 }),
    );
    const other = instanceCalls(clock, database, "instance-2").gateOf(
      "left-model-provider",
      RateLimitPolicy.of({ maxConcurrentCalls: 1 }),
    );
    if (gate === undefined || other === undefined) throw new Error("no gate");
    const left = gate
      .enter({ tenantId: "t1", weight: 1, signal: leaving.signal })
      .catch((error: unknown) => error);

    expect(await left).toMatchObject({ message: "the caller left" });
    await clock.advance(seconds(1));

    expect(await isAdmitted(other, clock, seconds(1))).toBe(true);
  });
});
