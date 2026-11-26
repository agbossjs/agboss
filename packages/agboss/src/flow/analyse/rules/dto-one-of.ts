import { ComponentKind } from "../../runtime/records.js";
import { ambiguousPairOf } from "../../../dto/ambiguity.js";
import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { OutputShape } from "../../dto-wrappers.js";
import { dtoLabel } from "../labels.js";
import type { AnalysisContext } from "./context.js";

/**
 * An `@Action` whose `output` is `oneOf(A, B, …)` or `listOf(A, B, …)` returns plain objects: the
 * runtime tells the class of each by its strict schema (no undeclared field). Two classes one value
 * could satisfy would make that a guess → `[dto.ambiguous-one-of]` (#1288).
 */

const variantsOfOutput = (output: OutputShape): readonly DtoClass[] =>
  typeof output === "function" ? [] : output.variants;

export function dtoOneOfRules(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== ComponentKind.Action || declaration.options.output === undefined)
      return [];
    const pair = ambiguousPairOf(variantsOfOutput(declaration.options.output));
    if (pair === undefined) return [];
    const first = dtoLabel(pair[0]);
    const second = dtoLabel(pair[1]);
    const message =
      `${node.name}: ${first} and ${second} are not distinguishable by their fields — one plain value ` +
      "could be either; give them a field the other lacks (a kind field), or return one class";
    return [violation("dto.ambiguous-one-of", message, [node.name])];
  });
}
