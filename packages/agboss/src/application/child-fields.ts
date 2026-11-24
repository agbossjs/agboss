import { CHILD_CLAIM_TIMEOUT } from "../flow/child-placement.js";
import type { ChildPlacement } from "../flow/child-placement.js";
import type { Milliseconds } from "../units/index.js";
import type { ApplicationOptions } from "./application.js";

/** `childClaimTimeout` and the default placement of the children (#1286), as the assembled application keeps them. */
export function childFieldsOf(options: ApplicationOptions): {
  readonly childClaimTimeout: Milliseconds;
  readonly childPlacement?: ChildPlacement;
} {
  const placement = options.defaults?.workflows?.placement;
  return {
    childClaimTimeout: options.childClaimTimeout ?? CHILD_CLAIM_TIMEOUT,
    ...(placement === undefined ? {} : { childPlacement: placement }),
  };
}
