import type { FlowNodeKind } from "../../ast.js";
import { ComponentKind } from "../../runtime/records.js";
import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ComponentDeclaration, InputFields } from "../../decorators/declaration.js";
import {
  isValueShape,
  Wrapper,
  type HistoryWrapper,
  type OutputShape,
  type ValueShape,
} from "../../dto-wrappers.js";
import { dtoNameProblem, kindSuffixProblem, type NameProblem, type NameKind } from "../../names.js";
import { DtoRegistry, dtoClashMessage } from "../../registry.js";
import type { AnalysisContext } from "./context.js";

/**
 * Name rules (#272 AC13, #270 AC14, S5): every `name` ends with its kind (`[name.kind-suffix]`);
 * every DTO class used as an input, an output, or a `.toOneOf([…])` branch ends with `Dto`
 * (`[dto.name]`); DTO class names are unique, because they key checkpoints (`[dto.duplicate-name]`).
 */

const NAME_KINDS: Readonly<Record<FlowNodeKind, NameKind>> = {
  [ComponentKind.WorkflowStart]: ComponentKind.WorkflowStart,
  [ComponentKind.WorkflowFinish]: ComponentKind.WorkflowFinish,
  [ComponentKind.Agent]: ComponentKind.Agent,
  [ComponentKind.Action]: ComponentKind.Action,
  [ComponentKind.Router]: ComponentKind.Router,
  [ComponentKind.Workflow]: ComponentKind.Workflow,
  [ComponentKind.ExternalTask]: ComponentKind.ExternalTask,
};

/** The DTO classes inside a shape. */
function dtosOf(shape: ValueShape | OutputShape | HistoryWrapper): readonly DtoClass[] {
  if (typeof shape === "function") return [shape];
  switch (shape.kind) {
    case Wrapper.List:
      return dtosOf(shape.element);
    case Wrapper.Optional:
      return dtosOf(shape.inner);
    case Wrapper.OneOf:
      return shape.variants;
    case Wrapper.History:
      return [shape.dto];
  }
}

const dtosOfFields = (
  fields: InputFields | Readonly<Record<string, ValueShape>> | undefined,
): readonly DtoClass[] => Object.values(fields ?? {}).flatMap(dtosOf);

/** The DTO classes a component declares: its input fields and its output. */
export function declaredDtos(declaration: ComponentDeclaration): readonly DtoClass[] {
  switch (declaration.kind) {
    case ComponentKind.WorkflowStart: {
      const { input } = declaration.options;
      return isValueShape(input) ? dtosOf(input) : dtosOfFields(input);
    }
    case ComponentKind.Agent:
    case ComponentKind.Action:
    case ComponentKind.ExternalTask: {
      const { input, output } = declaration.options;
      return [...dtosOfFields(input), ...(output === undefined ? [] : dtosOf(output))];
    }
    case ComponentKind.WorkflowFinish:
      return dtosOf(declaration.options.output);
    case ComponentKind.Router:
      return dtosOfFields(declaration.options.input);
    case ComponentKind.Workflow:
      return [];
  }
}

/** Every DTO class the workflow uses, once each, in a canonical order. */
function usedDtos(context: AnalysisContext): readonly DtoClass[] {
  const nodes = [...context.graph.nodes.values()].flatMap((node) => declaredDtos(node.declaration));
  const edges = context.graph.edges.flatMap((edge) =>
    edge.writes.flatMap((write) => dtosOf(write.shape)),
  );
  return [...new Set([...nodes, ...edges])].sort((first, second) =>
    first.name.localeCompare(second.name),
  );
}

/** The module a class is exported from, when the loader gave the modules. */
const fileOf = (context: AnalysisContext, exported: unknown): string | undefined =>
  context.options.modules?.find((module) => Object.values(module.exports).includes(exported))?.file;

const fromProblem = (problem: NameProblem, node: string): RuleViolation =>
  violation(problem.code, problem.message, [node]);

export function nameRules(context: AnalysisContext): readonly RuleViolation[] {
  const named = (name: string, kind: NameKind) => ({ name, kind });
  const components = [
    named(context.workflow.name, ComponentKind.Workflow),
    ...[...context.graph.nodes.values()].map((node) => named(node.name, NAME_KINDS[node.kind])),
  ].flatMap(({ name, kind }) => {
    const problem = kindSuffixProblem(name, kind);
    return problem === undefined ? [] : [fromProblem(problem, name)];
  });
  const registry = new DtoRegistry();
  const dtos = usedDtos(context).flatMap((dto) => {
    const problem = dtoNameProblem(dto);
    const clash = registry.register(dto, fileOf(context, dto));
    return [
      ...(problem === undefined ? [] : [fromProblem(problem, dto.name)]),
      ...(clash === undefined
        ? []
        : [violation("dto.duplicate-name", dtoClashMessage(clash), [dto.name])]),
    ];
  });
  return [...components, ...dtos];
}
