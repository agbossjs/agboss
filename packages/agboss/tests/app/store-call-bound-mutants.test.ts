/**
 * #1069 — what the mutation shard `store-bound` found unproved in the bound's own code: a result
 * that is not a promise or an iterable comes back as it is, an iterator without `return`, the
 * close that runs detached and says so when it fails, the clock's timer ended with the call, a late
 * answer of a call that gave up changing nothing, a hook or a symbol never bounded, a synchronous
 * throw, and a rejection that cannot even be turned into text still settling the call.
 */
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedStoreOf } from "../../src/app/store-call-bound.js";
import { leaseScope } from "../../src/app/lease-scope.js";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import { ExecutionLeaseLostError, StoreOutcomeSource } from "../../src/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { heldLease, outcomeOf, rejectWith, silent } from "./fixtures/bound-stubs.js";

interface Entry {
  readonly code: string;
  readonly message: string;
  readonly meta: unknown;
}

/** A log that keeps what it was told. */
function recorder(): { readonly entries: Entry[]; readonly log: FrameworkLog } {
  const entries: Entry[] = [];
  const log: FrameworkLog = {
    info: () => undefined,
    warn: (code, message, meta) => void entries.push({ code, message, meta }),
    error: () => undefined,
  };
  return { entries, log };
}

/** A clock that keeps the signal of every sleep it was given. */
class SpyClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];
  override sleep(delay: Parameters<VirtualClock["sleep"]>[0], signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});
/** Reads an iterable to its end, or until it throws. */
async function drain<T>(items: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const item of items) seen.push(item);
  return seen;
}
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 20));

const unknownError = (source = StoreOutcomeSource.Transport): StoreError.OutcomeUnknown =>
  new StoreError.OutcomeUnknown({ store: "Kv", operation: "get", source });

abstract class Kv {
  abstract get(): Promise<string>;
}
class MemoryKv extends Kv {
  constructor(private readonly answer: () => Promise<string>) {
    super();
  }
  get(): Promise<string> {
    return this.answer();
  }
}

describe("#1069: a result that is neither a promise nor an iterable", () => {
  const plain = { a: 1 };
  const thenless = { then: 1 };
  class Odd {
    nothing(): unknown {
      return null;
    }
    nobody(): unknown {
      return undefined;
    }
    text(): unknown {
      return "text";
    }
    plain(): unknown {
      return plain;
    }
    thenless(): unknown {
      return thenless;
    }
  }

  it("comes back as the very value", () => {
    const store = boundedStoreOf(Odd, new Odd(), { clock: new VirtualClock() });

    expect(store.nothing()).toBeNull();
    expect(store.nobody()).toBeUndefined();
    expect(store.text()).toBe("text");
    expect(store.plain()).toBe(plain);
    expect(store.thenless()).toBe(thenless);
  });
});

describe("#1069: an async iterator", () => {
  class Source {
    constructor(private readonly iterator: () => object) {}
    items(): AsyncIterable<number> {
      const iterator = this.iterator();
      return { [Symbol.asyncIterator]: () => iterator as AsyncIterator<number> };
    }
  }

  it("without a return method is read to its end", async () => {
    let next = 0;
    const store = boundedStoreOf(
      Source,
      new Source(() => ({
        next: () =>
          Promise.resolve(next < 2 ? { done: false, value: ++next } : { done: true, value: 0 }),
      })),
      { clock: new VirtualClock() },
    );

    const seen: number[] = [];
    for await (const value of store.items()) seen.push(value);

    expect(seen).toEqual([1, 2]);
  });

  /** A source whose first step never answers and whose close rejects with `closeError`. */
  const stuck = (closeError: unknown) =>
    new Source(() => ({
      next: () => silent<IteratorResult<number>>(),
      return: () => rejectWith(closeError),
    }));

  it("whose step gave up is closed detached: its late rejection is logged with the call's names", async () => {
    const { entries, log } = recorder();
    const clock = new VirtualClock();
    const store = boundedStoreOf(Source, stuck(new Error("close boom")), { clock, log });

    const reading = outcomeOf(drain(store.items()));
    await clock.advance(seconds(16));
    expect(await reading).toBeInstanceOf(StoreError.CallTimeout);
    await flush();

    expect(entries.filter((entry) => entry.code === "store.call-close-failed")).toEqual([
      {
        code: "store.call-close-failed",
        message: "closing the Source.items iterator after its bound failed: close boom",
        meta: { executionId: undefined, tenantId: undefined },
      },
    ]);
  });

  it("closed after a leased step gave up names the lease's execution and tenant; a non-Error is its text", async () => {
    const { entries, log } = recorder();
    const clock = new VirtualClock();
    const store = boundedStoreOf(Source, stuck("plain text"), { clock, log });
    const { lease } = heldLease(seconds(25));

    const reading = outcomeOf(leaseScope(lease, () => drain(store.items())));
    await clock.advance(seconds(26));
    expect(await reading).toBeInstanceOf(ExecutionLeaseLostError);
    await flush();

    expect(entries.filter((entry) => entry.code === "store.call-close-failed")).toEqual([
      {
        code: "store.call-close-failed",
        message: "closing the Source.items iterator after its bound failed: plain text",
        meta: { executionId: "root-1", tenantId: "default" },
      },
    ]);
  });

  it("whose late close rejects is no unhandled rejection where nothing is logging", async () => {
    const clock = new VirtualClock();
    const store = boundedStoreOf(Source, stuck(new Error("close boom")), { clock });

    const reading = outcomeOf(drain(store.items()));
    await clock.advance(seconds(16));
    await reading;
    await flush();

    expect(unhandled).toEqual([]);
  });

  it("whose step gave up and that has no return method is left as it is", async () => {
    const clock = new VirtualClock();
    const store = boundedStoreOf(
      Source,
      new Source(() => ({ next: () => silent<IteratorResult<number>>() })),
      { clock },
    );

    const reading = outcomeOf(drain(store.items()));
    await clock.advance(seconds(16));

    expect(await reading).toBeInstanceOf(StoreError.CallTimeout);
    await flush();
    expect(unhandled).toEqual([]);
  });
});

describe("#1069: the clock's timer ends with the call", () => {
  it("an answered call aborts its sleep", async () => {
    const clock = new SpyClock();
    const store = boundedStoreOf(Kv, new MemoryKv(() => Promise.resolve("v")), { clock });

    expect(await store.get()).toBe("v");

    expect(clock.signals).toHaveLength(1);
    expect(clock.signals[0]?.aborted).toBe(true);
  });

  it("a rejected call aborts its sleep", async () => {
    const clock = new SpyClock();
    const store = boundedStoreOf(Kv, new MemoryKv(() => Promise.reject(new Error("no"))), {
      clock,
    });

    await outcomeOf(store.get());

    expect(clock.signals[0]?.aborted).toBe(true);
  });

  it("a leased call that answers aborts its sleep, which also hears the lease's loss", async () => {
    const clock = new SpyClock();
    const store = boundedStoreOf(Kv, new MemoryKv(() => Promise.resolve("v")), { clock });
    const { lease } = heldLease(seconds(25));

    await leaseScope(lease, async () => store.get());

    expect(clock.signals[0]?.aborted).toBe(true);
  });
});

describe("#1069: the answer of a call that gave up changes nothing more", () => {
  it("an unleased call's late rejection is not counted and logged a second time", async () => {
    const { entries, log } = recorder();
    const counted: unknown[] = [];
    const clock = new VirtualClock();
    let rejectLate: (error: unknown) => void = () => undefined;
    const store = boundedStoreOf(
      Kv,
      new MemoryKv(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectLate = reject;
          }),
      ),
      { clock, log, timedOut: { add: (_count, attributes) => void counted.push(attributes) } },
    );

    const call = outcomeOf(store.get());
    await clock.advance(seconds(16));
    expect(await call).toBeInstanceOf(StoreError.CallTimeout);
    rejectLate(
      new StoreError.CallTimeout({
        store: "Kv",
        operation: "get",
        timeout: 1000 as never,
        source: StoreOutcomeSource.Command,
      }),
    );
    await flush();

    expect(entries.filter((entry) => entry.code === "store.call-timeout")).toHaveLength(1);
    expect(counted).toHaveLength(1);
  });

  it("a leased call's late unknown outcome hands over no second time", async () => {
    const clock = new VirtualClock();
    let rejectLate: (error: unknown) => void = () => undefined;
    const store = boundedStoreOf(
      Kv,
      new MemoryKv(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectLate = reject;
          }),
      ),
      { clock },
    );
    const { lease, abandoned } = heldLease(seconds(25));

    const call = outcomeOf(leaseScope(lease, async () => store.get()));
    await clock.advance(seconds(26));
    expect(await call).toBeInstanceOf(ExecutionLeaseLostError);
    rejectLate(unknownError());
    await flush();

    expect(abandoned).toHaveLength(1);
  });
});

describe("#1069: a rejection of any value settles the call", () => {
  it("a value that cannot be turned into text still ends the call, with the value as its cause", async () => {
    const hostile = {
      toString(): string {
        throw new Error("no text for this");
      },
    };
    const store = boundedStoreOf(Kv, new MemoryKv(() => rejectWith(hostile)), {
      clock: new VirtualClock(),
    });

    let settled: unknown = "pending";
    void outcomeOf(store.get()).then((outcome) => {
      settled = outcome;
    });
    await flush();

    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).cause).toBe(hostile);
    expect((settled as Error).message).toBe("a value that cannot be read as text");
    expect(unhandled).toEqual([]);
  });

  it("a hostile value closing a given-up iterator is no unhandled rejection", async () => {
    const hostile = {
      toString(): string {
        throw new Error("no text for this");
      },
    };
    class Source {
      items(): AsyncIterable<number> {
        const iterator = {
          next: () => silent<IteratorResult<number>>(),
          return: () => rejectWith(hostile),
        };
        return { [Symbol.asyncIterator]: () => iterator as AsyncIterator<number> };
      }
    }
    const { entries, log } = recorder();
    const clock = new VirtualClock();
    const store = boundedStoreOf(Source, new Source(), { clock, log });

    const reading = outcomeOf(drain(store.items()));
    await clock.advance(seconds(16));
    await reading;
    await flush();

    expect(unhandled).toEqual([]);
    expect(entries.map((entry) => entry.code)).toContain("store.call-close-failed");
  });

  it("a failure report that itself throws still ends the call with the store's error", async () => {
    const error = unknownError();
    const store = boundedStoreOf(Kv, new MemoryKv(() => Promise.reject(error)), {
      clock: new VirtualClock(),
    });
    const { lease } = heldLease(seconds(25));
    const broken = Object.create(lease, {
      leaseExecutionId: {
        get: (): string => {
          throw new Error("the lease cannot be read");
        },
      },
    }) as typeof lease;

    const outcome = await leaseScope(broken, () => outcomeOf(store.get()));

    expect(outcome).toBe(error);
    expect(unhandled).toEqual([]);
  });

  it("a value that is not an Error is one, with its text and itself as the cause", async () => {
    const store = boundedStoreOf(Kv, new MemoryKv(() => rejectWith("boom")), {
      clock: new VirtualClock(),
    });

    const error = await outcomeOf(store.get());

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom");
    expect((error as Error).cause).toBe("boom");
  });
});

describe("#1069: a method that throws at once", () => {
  class Sync {
    constructor(private readonly error: Error) {}
    run(): Promise<string> {
      throw this.error;
    }
  }
  const caught = (call: () => unknown): unknown => {
    try {
      call();
    } catch (error) {
      return error;
    }
    return "returned";
  };

  it("with an outcome unknown and no lease is thrown as it is", () => {
    const error = unknownError();
    const store = boundedStoreOf(Sync, new Sync(error), { clock: new VirtualClock() });

    expect(caught(() => store.run())).toBe(error);
  });

  it("under a lease with an error of known outcome is thrown as it is", async () => {
    const error = new Error("plain");
    const store = boundedStoreOf(Sync, new Sync(error), { clock: new VirtualClock() });
    const { lease, abandoned } = heldLease(seconds(25));

    expect(await leaseScope(lease, () => Promise.resolve(caught(() => store.run())))).toBe(error);
    expect(abandoned).toEqual([]);
  });

  it("under a lease with an outcome unknown is a rejection that is a hand-over", async () => {
    const error = unknownError();
    const store = boundedStoreOf(Sync, new Sync(error), { clock: new VirtualClock() });
    const { lease, abandoned } = heldLease(seconds(25));

    const outcome = await leaseScope(lease, () => outcomeOf(store.run()));

    expect(outcome).toBeInstanceOf(ExecutionLeaseLostError);
    expect(abandoned).toEqual([error]);
  });
});

describe("#1069: what is never a store call", () => {
  const hung = silent<undefined>();
  const symbol = Symbol("own");
  class Hooked {
    onInit(): Promise<void> {
      return hung;
    }
    onStart(): Promise<void> {
      return hung;
    }
    onStop(): Promise<void> {
      return hung;
    }
    onDestroy(): Promise<void> {
      return hung;
    }
    [symbol](): number {
      return 1;
    }
  }

  it.each(["onInit", "onStart", "onStop", "onDestroy"] as const)(
    "the lifecycle hook %s is the store's own, never bounded",
    (hook) => {
      const store = boundedStoreOf(Hooked, new Hooked(), { clock: new VirtualClock() });

      expect(store[hook]()).toBe(hung);
    },
  );

  it("a function under a symbol is the store's own", () => {
    const store = boundedStoreOf(Hooked, new Hooked(), { clock: new VirtualClock() });

    expect(store[symbol]).toBe(Hooked.prototype[symbol]);
  });

  it("the constructor is the store's own", () => {
    const store = boundedStoreOf(Hooked, new Hooked(), { clock: new VirtualClock() });

    expect(store.constructor).toBe(Hooked);
  });
});
