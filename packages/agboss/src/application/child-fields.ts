import { CHILD_CLAIM_TIMEOUT } from "../flow/child-placement.js";
import type { ChildPlacement } from "../flow/child-placement.js";
import type { Milliseconds } from "../units/index.js";
import type { ApplicationOptions, IsolatedWorkerOptions } from "./application.js";

/** `childClaimTimeout`, the default placement of the children and the fork entry of an `IsolatedWorker` (#1286), as the assembled application keeps them. */
export function childFieldsOf(options: ApplicationOptions): {
  readonly childClaimTimeout: Milliseconds;
  readonly childPlacement?: ChildPlacement;
  readonly isolatedWorker?: IsolatedWorkerOptions;
} {
  const placement = options.defaults?.workflows?.placement;
  return {
    childClaimTimeout: options.executionLimits?.childClaimTimeout ?? CHILD_CLAIM_TIMEOUT,
    ...(placement === undefined ? {} : { childPlacement: placement }),
    ...(options.isolatedWorker === undefined ? {} : { isolatedWorker: options.isolatedWorker }),
  };
}
