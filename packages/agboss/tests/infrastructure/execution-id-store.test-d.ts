import { describe, expectTypeOf, it } from "vitest";
import type { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import type { ClusterLeaseMirror } from "../../src/stores/index.js";
import {
  EXECUTION_ID_STORE,
  type ExecutionIdStore,
  type ExecutionLeaseRepository,
  type InjectionToken,
  type SqliteExecutionLeaseRepository,
} from "../../src/index.js";

/** What a coordination store of #1198 hands the durable one: the three methods, no fewer. */
describe("#1198: ExecutionIdStore asks for the cancel mark as well as the ids", () => {
  it("is the id claim, the cancel request and the cancel read of a lease store", () => {
    // #1321e (D6): the pause marks and fence too, and the mirror of the cluster's leases
    expectTypeOf<ExecutionIdStore>().toEqualTypeOf<
      Pick<
        ExecutionLeaseRepository,
        | "claimExecutionId"
        | "requestCancel"
        | "isCancelRequested"
        | "requestStop"
        | "stopOf"
        | "requestPause"
        | "unpause"
        | "pauseOf"
        | "markedOf"
      > &
        ClusterLeaseMirror
    >();
    expectTypeOf(EXECUTION_ID_STORE).toEqualTypeOf<InjectionToken<ExecutionIdStore>>();
  });

  it("a durable lease store satisfies it (the contract and SQLite's store)", () => {
    expectTypeOf<InMemoryExecutionLeaseRepository>().toExtend<ExecutionIdStore>();
    expectTypeOf<SqliteExecutionLeaseRepository>().toExtend<ExecutionIdStore>();
    // the contract alone mirrors no cluster lease
    expectTypeOf<ExecutionLeaseRepository>().not.toExtend<ExecutionIdStore>();
  });

  it("a store that claims ids only does not: a missing method fails at compile time", () => {
    type ClaimsOnly = Pick<ExecutionLeaseRepository, "claimExecutionId">;
    type NoCancelRead = Pick<ExecutionLeaseRepository, "claimExecutionId" | "requestCancel">;
    type NoCancelRequest = Pick<ExecutionLeaseRepository, "claimExecutionId" | "isCancelRequested">;
    type NoClaim = Pick<ExecutionLeaseRepository, "requestCancel" | "isCancelRequested">;

    expectTypeOf<ClaimsOnly>().not.toExtend<ExecutionIdStore>();
    expectTypeOf<NoCancelRead>().not.toExtend<ExecutionIdStore>();
    expectTypeOf<NoCancelRequest>().not.toExtend<ExecutionIdStore>();
    expectTypeOf<NoClaim>().not.toExtend<ExecutionIdStore>();
  });
});
