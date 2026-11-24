import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import type { AgentDeclaration } from "../../decorators/declaration.js";
import { Wrapper, type OutputShape } from "../../dto-wrappers.js";
import { toKebabCase } from "../../names.js";
import { dtoLabel, shapeLabel } from "../labels.js";
import type { AnalysisContext } from "./context.js";

/**
 * An agent with `output` answers through answer tools, one per allowed class (#272 S6):
 * `answer-<kebab of the DTO class>`. A tool name over 64 characters → `[tool.name-too-long]`; a model
 * that cannot call tools → `[model.no-tool-calling]` (checked when the caller knows the models).
 */

/** The longest tool name a model API accepts. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** The answer tool of one output class: `answer-profile-dto`. */
export const answerToolName = (dto: DtoClass): string => `answer-${toKebabCase(dtoLabel(dto))}`;

/** The classes an agent answers with: each `oneOf` variant, a list's elements, or the one DTO. */
function answerClasses(output: OutputShape): readonly DtoClass[] {
  if (typeof output === "function") return [output];
  if (output.kind === Wrapper.OneOf) return output.variants;
  return answerClasses(output.element);
}

function agentViolations(
  context: AnalysisContext,
  name: string,
  declaration: AgentDeclaration,
): readonly RuleViolation[] {
  const { model } = declaration.options;
  const output = declaration.options.output;
  if (output === undefined) return [];
  const tooLong = answerClasses(output)
    .map(answerToolName)
    .filter((tool) => tool.length > MAX_TOOL_NAME_LENGTH)
    .map((tool) => {
      const message =
        `${name}: the answer tool ${tool} has ${String(tool.length)} characters (at most ` +
        `${String(MAX_TOOL_NAME_LENGTH)}) — give its DTO class a shorter name`;
      return violation("tool.name-too-long", message, [name]);
    });
  const canCallTools = context.options.canCallTools?.(model) ?? true;
  if (canCallTools) return tooLong;
  const message = `${name} has output: ${shapeLabel(output)}, but ${model} cannot call tools — pick a model that can`;
  return [...tooLong, violation("model.no-tool-calling", message, [name])];
}

export function modelRules(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Agent
      ? agentViolations(context, node.name, node.declaration)
      : [],
  );
}
