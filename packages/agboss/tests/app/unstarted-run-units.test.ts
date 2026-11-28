/**
 * #1356 (shard `recovery`) — a new run's first drain that is handed over (`unstarted-run.ts`, #1090): before its
 * holder began writing a checkpoint the caller is told the run did not start (the same lease-lost class under its
 * own code, the original its cause); after the first write, or for any other failure, the error is the plain one.
 */
import { describe, expect, it } from "vitest";
import type { HeldExecutionLease } from "../../src/app/execution-leases.js";
import { LeasedCheckpointSaver } from "../../src/app/leased-checkpointer.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { startedOrSaid } from "../../src/app/unstarted-run.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";

const leaseOf = (): HeldExecutionLease =>
  ({ renew: () => Promise.resolve(), release: () => Promise.resolve() }) as never;

const caught = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return undefined;
};

const NOT_STARTED = "execution.lease-lost.not-started";

describe("#1090: a new run handed over before its first checkpoint write", () => {
  it("a lease lost is told as not started: the lease-lost class with its own code and message, the original its cause", async () => {
    const lost = new ExecutionLeaseLostError({ rootExecutionId: "root-1", cause: new Error("db") });

    const error = await caught(startedOrSaid(leaseOf(), Promise.reject(lost)));

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(error).not.toBe(lost);
    expect(error).toHaveProperty("code", NOT_STARTED);
    expect(error).toHaveProperty("rootExecutionId", "root-1");
    expect(error).toHaveProperty("cause", lost.cause);
    expect((error as Error).message).toContain("the run did not start");
  });

  it("a write an external system refused (the family's `Fenced`) is a lease lost as well, naming the lease's execution, the refusal its cause", async () => {
    const fenced = new ExecutionError.Fenced({
      scopeKey: "acme:root-1",
      tenantId: "acme",
      leaseExecutionId: "root-1",
      token: 3,
    });

    const error = await caught(startedOrSaid(leaseOf(), Promise.reject(fenced)));

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(error).toHaveProperty("code", NOT_STARTED);
    expect(error).toHaveProperty("rootExecutionId", "root-1");
    expect(error).toHaveProperty("cause", fenced);
  });

  it("any other failure is its own, and a run that finished is its result", async () => {
    const failure = new Error("a step failed");

    expect(await caught(startedOrSaid(leaseOf(), Promise.reject(failure)))).toBe(failure);
    expect(await startedOrSaid(leaseOf(), Promise.resolve("done"))).toBe("done");
  });
});

describe("#1090: a new run handed over after its first checkpoint write", () => {
  it("is the plain hand-over, whichever of the two it is: that write may have been applied, recovery finds out", async () => {
    const lease = leaseOf();
    const inner = {
      serde: undefined,
      put: () => Promise.resolve({}),
    } as never;
    await new LeasedCheckpointSaver(inner, lease).put(
      {} as never,
      {} as never,
      {} as never,
      {},
    );
    const lost = new ExecutionLeaseLostError({ rootExecutionId: "root-1" });
    const fenced = new ExecutionError.Fenced({
      scopeKey: "acme:root-1",
      tenantId: "acme",
      leaseExecutionId: "root-1",
      token: 3,
    });

    expect(await caught(startedOrSaid(lease, Promise.reject(lost)))).toBe(lost);
    expect(await caught(startedOrSaid(lease, Promise.reject(fenced)))).toBe(fenced);
  });
});
