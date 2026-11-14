/**
 * #1058 (#928 AC1, P8) — a bounded call that returns an async iterator (the checkpoint saver's
 * `list`): each `next()` is bounded on its own, a hung one ends the consumer's `for await`, and the
 * source's `return()` is never awaited behind it (an async generator queues it behind a running `next()`).
 */
import { describe, expect, it } from "vitest";
import { leaseScope } from "../../src/app/lease-scope.js";
import {
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
  StoreOutcomeSource,
} from "../../src/index.js";
import { waitOf } from "../../src/infrastructure/clock.js";
import { seconds } from "../../src/units/index.js";
import { boundedOver, heldLease, outcomeOf, silent } from "./fixtures/bound-stubs.js";

abstract class Listing {
  abstract list(): AsyncGenerator<number>;
}

/** A source of `1`, then a step that never answers; `closed` counts the generator's own `finally`. */
class HungListing extends Listing {
  closed = 0;
  async *list(): AsyncGenerator<number> {
    try {
      yield 1;
      await silent();
      yield 2;
    } finally {
      this.closed += 1;
    }
  }
}

/** A source whose every step takes `each` ms of the test's clock and answers. */
class SlowListing extends Listing {
  constructor(
    readonly pause: (ms: number) => Promise<void>,
    readonly each: number,
  ) {
    super();
  }
  async *list(): AsyncGenerator<number> {
    for (const value of [1, 2, 3, 4]) {
      await this.pause(this.each);
      yield value;
    }
  }
}

const drain = async (source: AsyncIterable<number>, seen: number[]): Promise<void> => {
  for await (const value of source) seen.push(value);
};

describe("#1058: a bounded async iterable", () => {
  it("rejects a consumer whose next step never answers, at the bound, naming the call", async () => {
    const { store, clock, reported } = boundedOver(Listing, new HungListing());
    const seen: number[] = [];
    const outcome = outcomeOf(drain(store.list(), seen));

    await clock.advance(seconds(14));
    await clock.advance(seconds(1));
    const error = await outcome;

    expect(seen).toEqual([1]);
    expect(error).toBeInstanceOf(StoreCallTimeoutError);
    expect(error).toMatchObject({ operation: "list", source: StoreOutcomeSource.Framework });
    expect(reported.warned).toEqual(["store.call-timeout"]);
    expect(reported.counted).toHaveLength(1);
  });

  it("rejects a consumer whose very first step never answers", async () => {
    const hung: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: () => silent<IteratorResult<number>>() }),
    };
    const { store, clock } = boundedOver(Listing, { list: () => hung });
    const outcome = outcomeOf(drain(store.list(), []));

    await clock.advance(seconds(15));

    expect(await outcome).toBeInstanceOf(StoreCallTimeoutError);
  });

  it("hands over under a lease at the trust's end, and ends the consumer", async () => {
    const { store, clock } = boundedOver(Listing, new HungListing());
    const { lease, abandoned } = heldLease(seconds(25));
    const seen: number[] = [];
    const outcome = outcomeOf(leaseScope(lease, async () => drain(store.list(), seen)));

    await clock.advance(seconds(24));
    expect(abandoned).toEqual([]);
    await clock.advance(seconds(1));
    const error = await outcome;

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(abandoned).toHaveLength(1);
    expect(seen).toEqual([1]);
  });

  it("does not await the source's return() behind a hung step, and swallows its late rejection", async () => {
    let rejectReturn: (error: Error) => void = () => undefined;
    const returned: unknown[] = [];
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => silent<IteratorResult<number>>(),
        return: () => {
          returned.push("called");
          return new Promise<IteratorResult<number>>((_resolve, reject) => {
            rejectReturn = reject;
          });
        },
      }),
    };
    const { store, clock } = boundedOver(Listing, { list: () => source });
    const unhandled: unknown[] = [];
    const watch = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", watch);
    try {
      const outcome = outcomeOf(drain(store.list(), []));
      await clock.advance(seconds(15));

      expect(await outcome).toBeInstanceOf(StoreCallTimeoutError);
      expect(returned).toEqual(["called"]);
      rejectReturn(new Error("closed late"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", watch);
    }
  });

  it("bounds each step on its own: a slow but progressing iterator completes", async () => {
    const holder: { sleep: (ms: number) => Promise<void> } = { sleep: () => Promise.resolve() };
    const source = new SlowListing((ms) => holder.sleep(ms), seconds(10));
    const { store, clock, reported } = boundedOver(Listing, source);
    holder.sleep = (ms) => clock.sleep(waitOf(ms));
    const seen: number[] = [];
    const outcome = outcomeOf(drain(store.list(), seen));

    for (let step = 0; step < 4; step += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await clock.advance(seconds(10));
    }

    expect(await outcome).toBe("answered");
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(reported.warned).toEqual([]);
  });

  it("closes the source on an early break, and the consumer's break is not delayed", async () => {
    const source = new HungListing();
    const { store, reported } = boundedOver(Listing, source);

    for await (const value of store.list()) {
      expect(value).toBe(1);
      break;
    }

    expect(source.closed).toBe(1);
    expect(reported.warned).toEqual([]);
  });

  it("an early break over a source whose return() never answers ends at the bound", async () => {
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: 1 }),
        return: () => silent<IteratorResult<number>>(),
      }),
    };
    const { store, clock } = boundedOver(Listing, { list: () => source });
    const broke = (async () => {
      for await (const value of store.list()) if (value === 1) break;
    })();
    const outcome = outcomeOf(broke);

    await clock.advance(seconds(15));

    expect(await outcome).toBeInstanceOf(StoreCallTimeoutError);
  });
});
