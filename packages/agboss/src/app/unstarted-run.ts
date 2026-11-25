import type { HeldExecutionLease } from "./execution-leases.js";
import { hasStartedWriting } from "./leased-checkpointer.js";
import { ExecutionLeaseLostError, leaseLostBeforeStartError } from "./lease-lost.js";
import { ExecutionError } from "../core/error-families/run-errors.js";

/**
 * A new run handed over before its holder began writing a checkpoint (#1090): nothing is stored,
 * so the next take has nothing to continue — it ends the record failed (`NothingToRecoverError`).
 * The caller is told so: the run did not start. After the first write a hand-over stays the plain
 * one (that write may have been applied; recovery finds out).
 */
function unstartedOf(lease: HeldExecutionLease, error: unknown): unknown {
  if (hasStartedWriting(lease)) return error;
  if (error instanceof ExecutionLeaseLostError) return leaseLostBeforeStartError(error);
  // the family's fenced refusal (#1317c) is a lease lost as well: the same before the first write
  if (error instanceof ExecutionError.Fenced)
    return leaseLostBeforeStartError({ rootExecutionId: error.leaseExecutionId, cause: error });
  return error;
}

/** A new run's first drain under `lease`: its hand-over before any checkpoint write said so. */
export const startedOrSaid = <T>(lease: HeldExecutionLease, run: Promise<T>): Promise<T> =>
  run.catch((error: unknown) => {
    throw unstartedOf(lease, error);
  });
