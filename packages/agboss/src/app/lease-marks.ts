import type { ExecutionLeaseRepository } from "../infrastructure/execution-lease.repository.js";
import type { ExecutionLeases } from "./execution-leases.js";

/**
 * The marks of a tree's lease row as the app asks them (#909, #1341b): the cancel's and the stop's,
 * each written once durable and idempotent, read together by `markedOf`.
 */
export const leaseMarksOf = (
  repository: ExecutionLeaseRepository,
): Pick<
  ExecutionLeases,
  "requestCancel" | "isCancelRequested" | "requestStop" | "stopOf" | "markedOf"
> => ({
  requestCancel: (tree, transition) => repository.requestCancel(tree, transition),
  isCancelRequested: (tree) => repository.isCancelRequested(tree),
  requestStop: (tree, mode, transition) => repository.requestStop(tree, mode, transition),
  stopOf: (tree) => repository.stopOf(tree),
  markedOf: (tree) => repository.markedOf(tree),
});
