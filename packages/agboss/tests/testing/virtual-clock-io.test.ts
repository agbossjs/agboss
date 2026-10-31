/**
 * #511 AC1: `VirtualClock.advance` lets a networked store's round trip finish. A store call takes
 * real time — more than the one turn of the event loop `advance` gave the work it woke — so the
 * contract suites track every store call of their targets on the case's clock (`clock.track`),
 * and `advance` waits for the tracked work, before it moves the time and after each sleep it wakes,
 * bounded by `settleTimeout` of real time (`UnsettledWorkError`, never a hang).
 */
import { describe, expect, it } from "vitest";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { executionLeaseContract } from "../../src/testing/contracts/index.js";
import { trackedStore } from "../../src/testing/contracts/tracked-store.js";
import { UnsettledWorkError } from "../../src/testing/errors.js";
import { seconds } from "../../src/units/index.js";
import { inMemoryTarget } from "../infrastructure/contracts/store-kinds.js";

/** Real I/O latency: what a database round trip costs (tests may wait for real time). */
const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** `store` with every method call 20 ms of real time behind a network, then run on the store. */
function behindNetwork<TStore extends object>(store: TStore): TStore {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]): Promise<unknown> => {
        await realDelay(20);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

const NEVER = new Promise<never>(() => undefined);

describe("#511 AC1: lease-holder cases pass on a store with real I/O latency", () => {
  executionLeaseContract({
    ...inMemoryTarget(({ storeClock, application, database }) =>
      behindNetwork(new InMemoryExecutionLeaseRepository(storeClock, application, database)),
    ),
    name: "in-memory behind 20 ms of network",
  });
});

describe("#511 AC1: advance waits for tracked work", () => {
  it("AC1: work tracked before an advance reaches its next wait before the time moves", async () => {
    const clock = new VirtualClock();
    let isWoken = false;
    // a round trip, then a wait: without the drain the wait starts after the jump and never wakes
    const work = clock.track(realDelay(20)).then(async () => {
      await clock.sleep(seconds(1));
      isWoken = true;
    });

    await clock.advance(seconds(1));
    await work;

    expect(isWoken).toBe(true);
  });

  it("AC1: a woken sleep's tracked work settles before the next due sleep wakes", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    const first = clock.sleep(seconds(1)).then(async () => {
      await clock.track(realDelay(20));
      order.push("first's round trip");
    });
    const second = clock.sleep(seconds(2)).then(() => order.push("second woke"));

    await clock.advance(seconds(2));
    await Promise.all([first, second]);

    expect(order).toEqual(["first's round trip", "second woke"]);
  });

  it("AC1: track returns the work itself — a rejection reaches its caller, not advance", async () => {
    const clock = new VirtualClock();
    const failing = clock.track(Promise.reject(new Error("connection refused")));

    await expect(failing).rejects.toThrow("connection refused");
    await expect(clock.advance(seconds(1))).resolves.toBeUndefined();
  });

  it("AC1: work that never settles → UnsettledWorkError after settleTimeout, the test does not hang", async () => {
    const clock = new VirtualClock(undefined, { settleTimeout: seconds(0.05) });
    void clock.track(NEVER);

    const advanced = clock.advance(seconds(1));

    await expect(advanced).rejects.toBeInstanceOf(UnsettledWorkError);
    await expect(advanced).rejects.toMatchObject({ code: "test.unsettled-work", inFlight: 1 });
  });

  it("AC1: with nothing tracked, advance moves as before", async () => {
    const clock = new VirtualClock();
    const start = clock.now().getTime();

    await clock.advance("25h");

    expect(clock.now().getTime() - start).toBe(25 * 3_600_000);
  });
});

describe("#511 AC1: a contract target's store calls are tracked on the case's clock", () => {
  /** A store with an async call, a sync call and a plain field. */
  class FakeStore {
    readonly label = "fake";
    #calls = 0;

    async save(): Promise<number> {
      await realDelay(20);
      this.#calls += 1;
      return this.#calls;
    }

    count(): number {
      return this.#calls;
    }
  }

  it("AC1: an async call is tracked; a sync call and a field pass through, private state kept", async () => {
    const clock = new VirtualClock();
    const store = trackedStore(new FakeStore(), clock);
    let saved = 0;
    void store.save().then((calls) => {
      saved = calls;
    });

    await clock.advance(seconds(1));

    expect(saved).toBe(1);
    expect(store.count()).toBe(1);
    expect(store.label).toBe("fake");
    expect(store).toBeInstanceOf(FakeStore);
  });

  it("AC1: each store of a group is tracked; a value of the group is kept as is", async () => {
    const clock = new VirtualClock();
    const group = trackedStore({ effects: new FakeStore(), name: "group" }, clock);
    let saved = 0;
    void group.effects.save().then((calls) => {
      saved = calls;
    });

    await clock.advance(seconds(1));

    expect(saved).toBe(1);
    expect(group.name).toBe("group");
    expect(trackedStore("not a store", clock)).toBe("not a store");
  });
});
