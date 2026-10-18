import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import type { ComponentDeclaration, InputFields } from "../../decorators/declaration.js";
import {
  isValueShape,
  Wrapper,
  type HistoryWrapper,
  type OutputShape,
  type ValueShape,
} from "../../dto-wrappers.js";
import { dtoNameProblem, kindSuffixProblem, NameKind, type NameProblem } from "../../names.js";
import { DtoRegistry, dtoClashMessage } from "../../registry.js";
import type { AnalysisContext } from "./context.js";

/**
 * Name rules (#272 AC13, #270 AC14, S5): every `name` ends with its kind (`[name.kind-suffix]`);
 * every DTO class used as an input, an output, in `.returns(…)` or `caseOf(…)` ends with `Dto`
 * (`[dto.name]`); DTO class names are unique, because they key checkpoints (`[dto.duplicate-name]`).
 */

const NAME_KINDS: Readonly<Record<NodeKind, NameKind>> = {
  [NodeKind.Start]: NameKind.WorkflowStart,
  [NodeKind.Finish]: NameKind.WorkflowFinish,
  [NodeKind.Agent]: NameKind.Agent,
  [NodeKind.Action]: NameKind.Action,
  [NodeKind.Router]: NameKind.Router,
  [NodeKind.Workflow]: NameKind.Workflow,
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
function declaredDtos(declaration: ComponentDeclaration): readonly DtoClass[] {
  switch (declaration.kind) {
    case NodeKind.Start: {
      const { input } = declaration.options;
      return isValueShape(input) ? dtosOf(input) : dtosOfFields(input);
    }
    case NodeKind.Agent:
    case NodeKind.Action:
    case NodeKind.Finish: {
      const { input, output } = declaration.options;
      return [...dtosOfFields(input), ...(output === undefined ? [] : dtosOf(output))];
    }
    case NodeKind.Router:
      return dtosOfFields(declaration.options.input);
    case NodeKind.Workflow:
      return [];
  }
}

/** Every DTO class the workflow uses, once each, in a canonical order. */
function usedDtos(context: AnalysisContext): readonly DtoClass[] {
  const nodes = [...context.graph.nodes.values()].flatMap((node) => declaredDtos(node.declaration));
  const edges = context.graph.edges.flatMap((edge) =>
    edge.writes.flatMap((write) => [...dtosOf(write.shape), ...(write.about ?? [])]),
  );
  const cases = context.walked.switches.flatMap((site) => [
    ...site.step.cases.flatMap((branch) => [branch.dto, ...(branch.about ?? [])]),
    ...(site.returned === undefined ? [] : dtosOf(site.returned)),
  ]);
  return [...new Set([...nodes, ...edges, ...cases])].sort((first, second) =>
    first.name.localeCompare(second.name),
  );
}

/** The module a class is exported from, when the loader gave the modules. */
const fileOf = (context: AnalysisContext, exported: unknown): string | undefined =>
  context.options.modules?.find((module) => Object.values(module.exports).includes(exported))?.file;

const fromProblem = (problem: NameProblem, node: string): RuleViolation =>
  violation(problem.code, problem.message, [node]);

export function nameRules(context: AnalysisContext): readonly RuleViolation[] {
  const components = [
    { name: context.workflow.name, kind: NameKind.Workflow },
    ...[...context.graph.nodes.values()].map((node) => ({
      name: node.name,
      kind: NAME_KINDS[node.kind],
    })),
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
