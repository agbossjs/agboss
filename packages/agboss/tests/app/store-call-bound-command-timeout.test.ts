/**
 * #1060 (#928) — a store's own command timeout (`source: command`) is logged as `store.call-timeout`
 * and counted in `agboss.instance.store_calls.timed_out`, as the framework's bound is; a transport
 * error or any other store error is neither.
 */
import { describe, expect, it } from "vitest";
import { leaseScope } from "../../src/app/lease-scope.js";
import {
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "../../src/index.js";
import { waitOf } from "../../src/infrastructure/clock.js";
import { seconds } from "../../src/units/index.js";
import { boundedOver, heldLease, outcomeOf } from "./fixtures/bound-stubs.js";

abstract class Kv {
  abstract get(): Promise<string>;
}

const commandTimeout = (): StoreCallTimeoutError =>
  new StoreCallTimeoutError({
    store: "Kv",
    operation: "get",
    timeout: waitOf(10_000),
    source: StoreOutcomeSource.Command,
  });

describe("#1060: a store's own command timeout is logged and counted", () => {
  it("logs store.call-timeout and counts it with source command, and the caller gets the error", async () => {
    const own = commandTimeout();
    const { store, reported } = boundedOver(Kv, { get: () => Promise.reject(own) });

    expect(await outcomeOf(store.get())).toBe(own);

    expect(reported.warned).toEqual(["store.call-timeout"]);
    expect(reported.counted).toEqual([
      { contract: "Kv", operation: "get", source: "command", kind: "unleased" },
    ]);
  });

  it("counts it once under a lease, whose holder then hands over", async () => {
    const { store, reported } = boundedOver(Kv, { get: () => Promise.reject(commandTimeout()) });
    const { lease, abandoned } = heldLease(seconds(25));

    const error = await outcomeOf(leaseScope(lease, async () => store.get()));

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(abandoned).toHaveLength(1);
    expect(reported.counted).toEqual([
      { contract: "Kv", operation: "get", source: "command", kind: "leased" },
    ]);
  });

  it("neither logs nor counts a transport error or an ordinary failure", async () => {
    const transport = new StoreOutcomeUnknownError({
      store: "Kv",
      operation: "get",
      source: StoreOutcomeSource.Transport,
    });
    const { store, reported } = boundedOver(Kv, {
      get: () => Promise.reject(transport),
    });
    await outcomeOf(store.get());
    const other = boundedOver(Kv, { get: () => Promise.reject(new Error("boom")) });
    await outcomeOf(other.store.get());

    expect(reported.warned).toEqual([]);
    expect(reported.counted).toEqual([]);
    expect(other.reported.counted).toEqual([]);
  });
});
