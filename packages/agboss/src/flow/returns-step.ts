import type { DtoClass } from "../dto/types.js";
import type { ReturnedValue } from "./ast.js";
import type { ReturnsOptions } from "./builder-types.js";
import { isReturnedShape, Wrapper } from "./dto-wrappers.js";
import { FlowSyntaxError } from "./launch-step.js";

/** The `.returns(value, { about })` step of the path builder, read from its arguments (#299, S54). */

/** `{ about: PlanDto }` or `{ about: [PlanDto, BudgetDto] }` as a list; undefined without one. */
export function aboutTargets(options: ReturnsOptions | undefined): readonly DtoClass[] | undefined {
  const about = options?.about;
  if (about === undefined) return undefined;
  const given: unknown = about;
  const targets: readonly unknown[] = Array.isArray(given) ? given : [given];
  if (targets.length === 0 || targets.some((target) => typeof target !== "function"))
    throw new FlowSyntaxError("{ about } names one DTO class or a non-empty list of them");
  return Object.freeze([...(targets as readonly DtoClass[])]);
}

/** The value of `.returns(value, options?)` (#299, S54): one shape, `{ about }` beside it. */
export function returnedValue(shape: unknown, options: unknown, extra: number): ReturnedValue {
  if (!isReturnedShape(shape))
    throw new FlowSyntaxError(".returns(…) takes a DTO class, optional(…), listOf(…) or oneOf(…)");
  if (extra > 0 || (options !== undefined && (typeof options !== "object" || options === null)))
    throw new FlowSyntaxError(
      ".returns(…) takes one value — chain .returns(A).returns(optional(B)) for several",
    );
  const about = aboutTargets(options);
  if (about === undefined) return Object.freeze({ shape });
  if (typeof shape !== "function" && shape.kind === Wrapper.OneOf)
    throw new FlowSyntaxError(
      "{ about } does not go on .returns(oneOf(…)) — write it on the case: caseOf(XDto, { about })",
    );
  return Object.freeze({ shape, about });
}
