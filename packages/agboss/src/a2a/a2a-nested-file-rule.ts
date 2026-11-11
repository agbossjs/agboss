import type { ApplicationOptions } from "../application/application.js";
import type { Provider } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { nestedFileFieldsOf } from "./files/a2a-file.dto.js";
import { finishDtosOf } from "./files/a2a-file-tier.js";

/**
 * Fail closed at assembly (#859): a file of an A2A message or answer is a part of its own, filled
 * into a top-level field — so an exported start's input, its finishes' outputs and an
 * `@A2AAgent`'s input and output hold `A2AFileDto` at the top level only. One below it (a nested
 * DTO's field, a list item's) would travel inside the data part as a descriptor the other side made:
 * `[a2a.nested-file-field]`, naming the DTO and the path.
 */

/** The DTOs an exported start carries: its input and its finishes' outputs. */
function exportedDtosOf(options: ApplicationOptions): readonly DtoClass[] {
  return (options.exposes ?? []).flatMap((expose) => {
    const meta = componentOf(expose);
    if (meta?.kind !== "a2a-expose") return [];
    return meta.meta.exports.flatMap((start) => {
      const declaration = declarationOf(start);
      if (declaration?.kind !== NodeKind.Start) return [];
      const { input } = declaration.options;
      const finishes = [...finishDtosOf(start, options.workflows).values()];
      return typeof input === "function" ? [input, ...finishes] : finishes;
    });
  });
}

/** The listed providers of the application and its workflows. */
const providersOf = (options: ApplicationOptions): readonly Provider[] => [
  ...(options.providers ?? []),
  ...options.workflows.flatMap((workflow) => {
    const declaration = declarationOf(workflow);
    return declaration?.kind === NodeKind.Workflow ? (declaration.options.providers ?? []) : [];
  }),
];

/** The DTOs each `@A2AAgent` sends and takes back. */
const agentDtosOf = (options: ApplicationOptions): readonly DtoClass[] =>
  providersOf(options).flatMap((provider) => {
    const meta = typeof provider === "function" ? componentOf(provider) : undefined;
    if (meta?.kind !== "a2a-agent") return [];
    return [meta.meta.input, meta.meta.output].flatMap((dto) => (dto === undefined ? [] : [dto]));
  });

/** `[a2a.nested-file-field]` of an application, or none. */
export function nestedFileFieldViolations(options: ApplicationOptions): RuleViolation[] {
  const dtos = new Set([...exportedDtosOf(options), ...agentDtosOf(options)]);
  return [...dtos].flatMap((dto) =>
    nestedFileFieldsOf(dto).map((path) =>
      violation(
        "a2a.nested-file-field",
        `${dto.name}.${path} holds an A2AFileDto below the top level: an A2A file is a part of its own, filled into a top-level field — move it up (@Nested(A2AFileDto) / @ListOf(A2AFileDto) on ${dto.name} itself)`,
        [dto.name],
      ),
    ),
  );
}
