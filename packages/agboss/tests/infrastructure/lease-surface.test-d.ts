import { describe, expectTypeOf, it } from "vitest";
import type * as Root from "../../src/index.js";
import type * as Contracts from "../../src/testing/contracts/index.js";
import type * as Testing from "../../src/testing/index.js";
import type {
  ChildExecutionQueueCounts,
  ChildExecutionQueueRepository,
  Clock,
  ExecutionFence,
  ExecutionLease,
  ExecutionLeaseRepository,
  PreviousLeaseHolder,
  StoreClock,
  StoreTime,
  StoreTimeSource,
} from "../../src/index.js";
import type { Milliseconds } from "../../src/units/index.js";

/**
 * #847 — the lease surface (0.1.1 API review G7): the store's time is branded, the store clock says
 * its source, the fencing token is `token` everywhere and the lease calls say what they do.
 */

describe("#847 AC1: StoreTime and StoreClock.source", () => {
  it("a Clock does not pass for a store clock: its now() is a plain Date", () => {
    expectTypeOf<StoreClock["now"]>().returns.toEqualTypeOf<StoreTime>();
    expectTypeOf<StoreClock["source"]>().toEqualTypeOf<StoreTimeSource>();
    expectTypeOf<Clock>().not.toExtend<Pick<StoreClock, "now">>();
    expectTypeOf<StoreClock>().toExtend<Pick<Clock, "now">>();
  });

  it("DatabaseStoreClock, TestStoreClock and isDatabaseTime are gone", () => {
    expectTypeOf<typeof Root>().not.toHaveProperty("DatabaseStoreClock");
    expectTypeOf<typeof Testing>().not.toHaveProperty("TestStoreClock");
    expectTypeOf<typeof Contracts>().not.toHaveProperty("TestStoreClock");
    expectTypeOf<StoreClock>().not.toHaveProperty("isDatabaseTime");
  });
});

describe("#847 AC2: the old names do not compile", () => {
  it("leaseEpoch is token on the lease and its previous holder", () => {
    expectTypeOf<ExecutionLease>().toHaveProperty("token").toEqualTypeOf<number>();
    expectTypeOf<ExecutionLease>().not.toHaveProperty("leaseEpoch");
    expectTypeOf<PreviousLeaseHolder>().toHaveProperty("token").toEqualTypeOf<number>();
    expectTypeOf<PreviousLeaseHolder>().not.toHaveProperty("leaseEpoch");
  });

  it("the lease store's calls: retire, claimExecutionId, a yield answering the time left", () => {
    expectTypeOf<ExecutionLeaseRepository>().toHaveProperty("retire");
    expectTypeOf<ExecutionLeaseRepository>().not.toHaveProperty("finish");
    expectTypeOf<ExecutionLeaseRepository>().toHaveProperty("claimExecutionId");
    expectTypeOf<ExecutionLeaseRepository>().not.toHaveProperty("saveExecutionIdIfAbsent");
    expectTypeOf<ExecutionLeaseRepository["yield"]>().returns.toEqualTypeOf<
      Promise<Milliseconds | undefined>
    >();
    expectTypeOf<ExecutionLeaseRepository["yield"]>().returns.toEqualTypeOf<
      ReturnType<ExecutionLeaseRepository["renew"]>
    >();
  });

  it("the fence: renewNow, trustedUntil, fencedError", () => {
    expectTypeOf<ExecutionFence>().toHaveProperty("renewNow");
    expectTypeOf<ExecutionFence>().toHaveProperty("trustedUntil").toEqualTypeOf<Date>();
    expectTypeOf<ExecutionFence>().toHaveProperty("fencedError");
    expectTypeOf<ExecutionFence>().not.toHaveProperty("confirmNow");
    expectTypeOf<ExecutionFence>().not.toHaveProperty("confirmedUntil");
    expectTypeOf<ExecutionFence>().not.toHaveProperty("fenced");
  });

  it("the child queue counts by status", () => {
    expectTypeOf<ChildExecutionQueueRepository>().toHaveProperty("countByStatus");
    expectTypeOf<ChildExecutionQueueRepository>().not.toHaveProperty("findQueueDepth");
    expectTypeOf<ChildExecutionQueueRepository["countByStatus"]>().returns.toEqualTypeOf<
      Promise<ChildExecutionQueueCounts>
    >();
    expectTypeOf<typeof Root>().not.toHaveProperty("ChildExecutionQueueDepth");
  });
});
