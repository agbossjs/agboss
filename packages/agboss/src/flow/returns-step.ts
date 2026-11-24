import type { ReturnedValue } from "./ast.js";
import { isReturnedShape } from "./dto-wrappers.js";
import { FlowSyntaxError } from "./launch-step.js";

/** The `.returns(value)` step of the path builder, read from its arguments (#299, S54). */

/** The value of `.returns(value)` (#299, S54): one shape — several are a chain. */
export function returnedValue(shape: unknown, extra: number): ReturnedValue {
  if (!isReturnedShape(shape))
    throw new FlowSyntaxError({
      message: ".returns(…) takes a DTO class, optional(…), listOf(…) or oneOf(…)",
    });
  if (extra > 0)
    throw new FlowSyntaxError({
      message: ".returns(…) takes one value — chain .returns(A).returns(optional(B)) for several",
    });
  return Object.freeze({ shape });
}
