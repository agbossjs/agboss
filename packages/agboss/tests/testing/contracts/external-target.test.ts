/**
 * #481 AC1: a store author's target, built only from the public entries (the lease store of
 * tests/fixtures/contracts/map-lease-store.ts imports `@agboss/core` and `/units` only), passes the
 * published lease contract — once synchronous and without `close`, once with an async `instance`,
 * an async `reset` and a `close`, every built store closed.
 */
import { describe, expect, it } from "vitest";
import { executionLeaseContract } from "../../../src/testing/contracts/index.js";
import type { ContractTarget } from "../../../src/testing/contracts/index.js";
import {
  LeaseTable,
  MapExecutionLeaseRepository,
} from "../../fixtures/contracts/map-lease-store.js";

let table = new LeaseTable();

describe("#481 AC1: an external-style target passes the lease contract", () => {
  executionLeaseContract({
    name: "external",
    reset: () => {
      table = new LeaseTable();
    },
    instance: (seam) => new MapExecutionLeaseRepository(table, seam.storeClock, seam.application),
  });
});

const lifecycle = { resets: 0, built: 0, closed: new Set<MapExecutionLeaseRepository>() };

const asyncTarget: ContractTarget<MapExecutionLeaseRepository> = {
  name: "external, async",
  reset: async () => {
    await Promise.resolve();
    table = new LeaseTable();
    lifecycle.resets += 1;
  },
  instance: async (seam) => {
    await Promise.resolve();
    lifecycle.built += 1;
    return new MapExecutionLeaseRepository(table, seam.storeClock, seam.application);
  },
  close: async (store) => {
    await Promise.resolve();
    lifecycle.closed.add(store);
  },
};

describe("#481: an async instance and an async reset", () => {
  executionLeaseContract(asyncTarget);

  it("each case reset the store once and closed both instances it built", () => {
    // the lease contract's 75 cases ran above, in order (#501: two of takenOverFrom; #516: ten of
    // a yielded lease, four of its edges; #520: eight of a finished lease, five of its edges, four
    // of the take of finished work; #534: the two cases exactly at the expiry replaced by fifteen of
    // the lease's expiry and six of the framework's holder at it; its acceptance: six races at the
    // edges and the renewal's end counted from it; #533: six of the store's time as the authority)
    expect(lifecycle.resets).toBe(75);
    expect(lifecycle.built).toBe(150);
    expect(lifecycle.closed.size).toBe(150);
  });
});
