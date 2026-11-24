/**
 * #1069 — the limit of a call, edge by edge: which lease is trusted (held, not yielded unless the
 * call is a reclaim, with time left), which calls of the lease store can be leased, which are long,
 * and the scope a call starts in.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  LONG_CONTRACTS,
  MAINTENANCE_METHODS,
  StoreCallKind,
  limitOf,
} from "../../src/app/store-call-kind.js";
import { callScopeOf, leaseScope, leasedRenewal, outsideLease } from "../../src/app/lease-scope.js";
import { LONG_CALL_BOUND, RENEW_BOUND, STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import type { Class } from "../../src/components/injection.js";
import type { FrameLease } from "../../src/flow/context/frame.js";
import { FileRepository } from "../../src/infrastructure/file.repository.js";
import { waitOf } from "../../src/infrastructure/clock.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { seconds } from "../../src/units/index.js";
import { heldLease } from "./fixtures/bound-stubs.js";

abstract class Kv {
  abstract get(): Promise<string>;
}

const limitUnder = (
  lease: FrameLease,
  contract: Class,
  method: string,
  scope: typeof leaseScope = leaseScope,
): Promise<ReturnType<typeof limitOf>> =>
  scope(lease, () => Promise.resolve(limitOf(contract, method)));

const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

describe("#1069: which lease a call is leased by", () => {
  const base = heldLease(seconds(25)).lease;

  it("a held lease with time left leases a call, for the time left", async () => {
    const limit = await limitUnder(base, Kv, "get");

    expect(limit).toEqual({ kind: StoreCallKind.Leased, bound: waitOf(seconds(25)), lease: base });
  });

  it.each([
    ["with no time left", { ...base, left: 0 }],
    ["with its time past", { ...base, left: -5 }],
    ["whose signal is aborted", { ...base, signal: aborted() }],
    ["whose signal is aborted and has no time left", { ...base, signal: aborted(), left: 0 }],
    ["yielded", { ...base, isYielded: true }],
    ["with no signal", { ...base, signal: undefined }],
    ["with nothing to abandon with", { ...base, abandon: undefined }],
    ["with no time said", { ...base, left: undefined }],
  ])("a lease %s leases nothing: the call is unleased", async (_name, lease) => {
    const limit = await limitUnder(lease, Kv, "get");

    expect(limit).toEqual({
      kind: StoreCallKind.Unleased,
      bound: STORE_CALL_BOUND,
      lease: undefined,
    });
  });

  it("a reclaim under a yielded lease is leased: it asks for its own token", async () => {
    const yielded = { ...base, isYielded: true };

    expect((await limitUnder(yielded, Kv, "reclaim")).kind).toBe(StoreCallKind.Leased);
    expect((await limitUnder(yielded, Kv, "get")).kind).toBe(StoreCallKind.Unleased);
  });

  it("a reclaim under a lease that is not yielded is leased too", async () => {
    expect((await limitUnder(base, Kv, "reclaim")).kind).toBe(StoreCallKind.Leased);
  });

  it("a reclaim is no excuse for a lost lease", async () => {
    expect((await limitUnder({ ...base, signal: aborted() }, Kv, "reclaim")).kind).toBe(
      StoreCallKind.Unleased,
    );
    expect((await limitUnder({ ...base, left: 0 }, Kv, "reclaim")).kind).toBe(
      StoreCallKind.Unleased,
    );
  });
});

describe("#1069: the lease store's own calls", () => {
  const { lease } = heldLease(seconds(25));

  it("a reclaim is leased", async () => {
    expect((await limitUnder(lease, ExecutionLeaseRepository, "reclaim")).kind).toBe(
      StoreCallKind.Leased,
    );
  });

  it("a renewal is leased only when it is the holder's own renewNow", async () => {
    expect((await limitUnder(lease, ExecutionLeaseRepository, "renew", leasedRenewal)).kind).toBe(
      StoreCallKind.Leased,
    );
    expect(await limitUnder(lease, ExecutionLeaseRepository, "renew")).toEqual({
      kind: StoreCallKind.Unleased,
      bound: RENEW_BOUND,
      lease: undefined,
    });
  });

  it("any other call of it is unleased, in a leased renewal as in a lease's scope", async () => {
    for (const scope of [leaseScope, leasedRenewal]) {
      expect((await limitUnder(lease, ExecutionLeaseRepository, "acquire", scope)).kind).toBe(
        StoreCallKind.Unleased,
      );
    }
  });
});

describe("#1069: long calls", () => {
  it("the maintenance deletes are long, and only `delete…Before` whole", () => {
    expect(MAINTENANCE_METHODS.test("deleteOutcomesBefore")).toBe(true);
    expect(MAINTENANCE_METHODS.test("deleteBefore")).toBe(true);
    expect(MAINTENANCE_METHODS.test("xdeleteOutcomesBefore")).toBe(false);
    expect(MAINTENANCE_METHODS.test("deleteOutcomesBeforeNow")).toBe(false);
    expect(limitOf(Kv, "deleteOutcomesBefore")).toEqual({
      kind: StoreCallKind.Long,
      bound: LONG_CALL_BOUND,
      lease: undefined,
    });
    expect(limitOf(Kv, "deleteOutcomesBeforeNow").kind).toBe(StoreCallKind.Unleased);
  });

  it("a call of any contract of the long set is long, not of one only", () => {
    abstract class Other {
      abstract read(): void;
    }
    const set = LONG_CONTRACTS as Set<Class>;
    set.add(Other);
    try {
      expect(limitOf(FileRepository, "read").kind).toBe(StoreCallKind.Long);
      expect(limitOf(Other, "read").kind).toBe(StoreCallKind.Long);
      expect(limitOf(Kv, "read").kind).toBe(StoreCallKind.Unleased);
    } finally {
      set.delete(Other);
    }
  });
});

describe("#1069: the scope a call starts in", () => {
  const { lease } = heldLease(seconds(25));
  afterEach(() => undefined);

  it("a lease's scope is a lease, not a renewal", async () => {
    expect(await leaseScope(lease, () => Promise.resolve(callScopeOf()))).toEqual({
      lease,
      isRenewal: false,
    });
  });

  it("a leased renewal is a lease and a renewal", async () => {
    expect(await leasedRenewal(lease, () => Promise.resolve(callScopeOf()))).toEqual({
      lease,
      isRenewal: true,
    });
  });

  it("work outside any lease has none and is no renewal, inside a lease's scope too", async () => {
    expect(await outsideLease(() => Promise.resolve(callScopeOf()))).toEqual({
      lease: undefined,
      isRenewal: false,
    });
    expect(
      await leaseScope(lease, () => outsideLease(() => Promise.resolve(callScopeOf()))),
    ).toEqual({ lease: undefined, isRenewal: false });
    expect(
      await leasedRenewal(lease, () => outsideLease(() => Promise.resolve(callScopeOf()))),
    ).toEqual({ lease: undefined, isRenewal: false });
  });

  it("no scope and no frame is no lease", () => {
    expect(callScopeOf()).toEqual({ lease: undefined, isRenewal: false });
  });
});
