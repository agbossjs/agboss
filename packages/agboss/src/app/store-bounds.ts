import type { Class } from "../components/injection.js";
import type { Clock } from "../infrastructure/clock.js";
import { boundedContractOf } from "../infrastructure/contracts.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { boundedStoreOf, type StoreCallParts } from "./store-call-bound.js";

/**
 * The bounds of one application instance's store calls (#928): its clock now, its log and its
 * counter once the instance has them — the stores are created before either exists.
 */
export class StoreBounds implements StoreCallParts {
  log: FrameworkLog | undefined;
  timedOut: StoreCallParts["timedOut"];

  constructor(readonly clock: Clock) {}

  /** The instance's log and counter: from now on a timeout is reported. */
  attach(log: FrameworkLog, timedOut: StoreCallParts["timedOut"]): void {
    this.log = log;
    this.timedOut = timedOut;
  }

  /** What the container stores for `instance` of `cls`: bounded when it is a store of a bounded contract. */
  readonly decorate = (cls: Class, instance: unknown): unknown => {
    const contract = boundedContractOf(cls);
    if (contract === undefined || typeof instance !== "object" || instance === null)
      return instance;
    return boundedStoreOf(contract, instance, this);
  };
}
