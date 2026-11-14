/**
 * #928 AC1 — every path of a bounded call settles: a lease whose `abandon` rejects, a log or a
 * counter that throws, a clock whose sleep rejects never leave the caller waiting, and nothing is
 * left as an unhandled rejection. A subclass registered as a contract is that contract everywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedStoreOf } from "../../src/app/store-call-bound.js";
import { limitOf } from "../../src/app/store-call-kind.js";
import { leaseScope } from "../../src/app/lease-scope.js";
import { A2AFileRepository } from "../../src/infrastructure/a2a-file.repository.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "../../src/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { boundedOver, heldLease, outcomeOf, silent } from "./fixtures/bound-stubs.js";

abstract class Kv {
  abstract get(): Promise<string>;
}

const unknown = (): StoreOutcomeUnknownError =>
  new StoreOutcomeUnknownError({
    store: "Kv",
    operation: "get",
    source: StoreOutcomeSource.Transport,
  });

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 20));

describe("#928: a bounded call settles on every path", () => {
  it("a leased call that ends unknown settles as a hand-over although abandon rejects", async () => {
    const { store } = boundedOver(Kv, { get: () => Promise.reject(unknown()) });
    const { lease } = heldLease(seconds(25));
    lease.abandon = () => Promise.reject(new Error("abandon failed"));

    const error = await outcomeOf(leaseScope(lease, async () => store.get()));
    await flush();

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(unhandled).toEqual([]);
  });

  it("a leased call that hangs settles at its bound although abandon rejects", async () => {
    const { store, clock } = boundedOver(Kv, { get: () => silent<string>() });
    const { lease } = heldLease(seconds(25));
    lease.abandon = () => Promise.reject(new Error("abandon failed"));

    const call = outcomeOf(leaseScope(lease, async () => store.get()));
    await clock.advance(seconds(26));

    expect(await call).toBeInstanceOf(ExecutionLeaseLostError);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it("an unleased call settles at its bound although the log and the counter throw", async () => {
    const clock = new VirtualClock();
    const store = boundedStoreOf(
      Kv,
      { get: () => silent<string>() },
      {
        clock,
        log: {
          info: () => undefined,
          warn: () => {
            throw new Error("the log is down");
          },
          error: () => undefined,
        },
        timedOut: {
          add: () => {
            throw new Error("the counter is down");
          },
        },
      },
    );

    const call = outcomeOf(store.get());
    await clock.advance(seconds(16));

    expect(await call).toBeInstanceOf(StoreCallTimeoutError);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it("a store error settles with itself although the log throws", async () => {
    const own = new StoreCallTimeoutError({
      store: "Kv",
      operation: "get",
      timeout: 10_000 as never,
      source: StoreOutcomeSource.Command,
    });
    const store = boundedStoreOf(
      Kv,
      { get: () => Promise.reject(own) },
      {
        clock: new VirtualClock(),
        log: {
          info: () => undefined,
          warn: () => {
            throw new Error("the log is down");
          },
          error: () => undefined,
        },
      },
    );

    expect(await outcomeOf(store.get())).toBe(own);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it("a clock whose sleep rejects counts as the bound reached: the call settles", async () => {
    class BrokenClock extends VirtualClock {
      override sleep(): Promise<void> {
        return Promise.reject(new Error("the timer failed"));
      }
    }
    const store = boundedStoreOf(Kv, { get: () => silent<string>() }, { clock: new BrokenClock() });

    const error = await outcomeOf(store.get());
    await flush();

    expect(error).toBeInstanceOf(StoreCallTimeoutError);
    expect(unhandled).toEqual([]);
  });
});

describe("#928: a subclass of a contract is that contract in every limit", () => {
  abstract class OwnLeases extends ExecutionLeaseRepository {}
  abstract class OwnFiles extends A2AFileRepository {}

  it("renews within the renewal's own bound, as the lease store does", () => {
    const own = limitOf(OwnLeases, "renew");
    expect(own).toEqual(limitOf(ExecutionLeaseRepository, "renew"));
    expect(own.bound).not.toEqual(limitOf(ExecutionLeaseRepository, "acquire").bound);
  });

  it("is a long call where its base is", () => {
    expect(limitOf(OwnFiles, "read")).toEqual(limitOf(A2AFileRepository, "read"));
  });
});
