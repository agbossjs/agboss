import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import { NodeKind, QuorumKind, StepKind, type FlowPath, type Step } from "../ast.js";
import {
  declarationOf,
  isFieldMap,
  type WorkflowDeclaration,
  type WorkflowStartDeclaration,
} from "../decorators/declaration.js";
import { oneOf, type OutputShape, type ValueShape } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import { isThisWorkflow } from "../this-workflow.js";
import { dtoLabel } from "./labels.js";
import { slotOfField, type SlotKey } from "./scope.js";

/**
 * A child workflow as its parent sees it (#263): a component "start input → one of its finishes'
 * outputs". Its starts with their input fields (one entry for a start taking one DTO or one list,
 * one per field of a map input), and its output — the output classes of its finishes, one value
 * when they share one class, a `oneOf(…)` of them otherwise (two finishes of one class are one
 * case). Read from the child's own declaration, never from the parent's graph.
 */

/** One field of a start's input: the whole input (`CompanyDto`, `listOf(…)`) or a map's field. */
export interface ChildStartField {
  /** The map's field name; the start's name for a whole input. */
  readonly name: string;
  readonly shape: ValueShape;
  readonly slot: SlotKey;
  readonly isRequired: boolean;
  readonly isList: boolean;
}

/** One start of the child: where its execution may enter. */
export interface ChildStart {
  readonly name: ComponentName;
  readonly component: Class;
  readonly fields: readonly ChildStartField[];
}

export interface ChildWorkflow {
  readonly name: ComponentName;
  readonly starts: readonly ChildStart[];
  /** The distinct output classes of its finishes, sorted by name. */
  readonly outputs: readonly DtoClass[];
  /** What it gives its parent: one class, a `oneOf(…)` of several, nothing without a finish. */
  readonly output?: OutputShape;
}

const fieldOf = (name: string, shape: ValueShape): ChildStartField => {
  const { slot, isRequired, isList } = slotOfField(shape);
  return { name, shape, slot, isRequired, isList };
};

function startOf(component: Class, declaration: WorkflowStartDeclaration): ChildStart {
  const name = declaration.options.name as ComponentName;
  const { input } = declaration.options;
  const fields = isFieldMap(input)
    ? Object.entries(input).map(([field, shape]) => fieldOf(field, shape))
    : [fieldOf(name, input)];
  return { name, component, fields };
}

/** Every step of a path and of its sub-paths (cases, routes, side paths). */
function allSteps(steps: readonly Step[]): readonly Step[] {
  return steps.flatMap((step): readonly Step[] => {
    switch (step.kind) {
      case StepKind.Switch:
        return [step, ...step.cases.flatMap((branch) => allSteps(branch.path.steps))];
      case StepKind.ChooseOne:
        return [step, ...step.routes.flatMap((route) => allSteps(route.path.steps))];
      case StepKind.OnError:
        return [step, ...allSteps(step.path.steps)];
      case StepKind.Join:
        return [step, ...step.onJoinError.flatMap((handler) => allSteps(handler.path.steps))];
      default:
        return [step];
    }
  });
}

/** The finish classes a flow names: `.toFinish(F)` and `route(F)`. */
function finishesOf(flow: readonly FlowPath[]): readonly Class[] {
  const targets = flow
    .flatMap((path) => allSteps(path.steps))
    .flatMap((step): readonly Class[] => {
      if (step.kind === StepKind.To)
        return step.targetKind === NodeKind.Finish ? [step.target] : [];
      return step.kind === StepKind.ChooseOne ? step.routes.map((route) => route.target) : [];
    });
  return [...new Set(targets)].filter((target) => declarationOf(target)?.kind === NodeKind.Finish);
}

function outputsOf(flow: readonly FlowPath[]): readonly DtoClass[] {
  const outputs = finishesOf(flow).flatMap((finish) => {
    const declaration = declarationOf(finish);
    return declaration?.kind === NodeKind.Finish ? [declaration.options.output] : [];
  });
  return [...new Set(outputs)].sort((first, second) =>
    dtoLabel(first).localeCompare(dtoLabel(second)),
  );
}

const outputShapeOf = (outputs: readonly DtoClass[]): OutputShape | undefined => {
  const [first, second, ...rest] = outputs;
  if (first === undefined) return undefined;
  return second === undefined ? first : oneOf(first, second, ...rest);
};

function summarise(declaration: WorkflowDeclaration): ChildWorkflow {
  const { flow, name } = declaration.options;
  const starts = flow.flatMap((path): readonly ChildStart[] => {
    if (path.source.kind !== NodeKind.Start) return [];
    const start = declarationOf(path.source.node);
    return start?.kind === NodeKind.Start ? [startOf(path.source.node, start)] : [];
  });
  const unique = [...new Map(starts.map((start) => [start.name, start])).values()].sort(
    (first, second) => first.name.localeCompare(second.name),
  );
  const outputs = outputsOf(flow);
  const output = outputShapeOf(outputs);
  return {
    name: name as ComponentName,
    starts: unique,
    outputs,
    ...(output === undefined ? {} : { output }),
  };
}

/** The node classes the steps name (a quorum group's own path included). */
function stepClassesOf(steps: readonly Step[]): readonly Class[] {
  return allSteps(steps).flatMap((step): readonly Class[] => {
    if (step.kind === StepKind.To) return [step.target];
    if (step.kind === StepKind.Launch) return step.targets;
    if (step.kind === StepKind.Join && step.quorum?.kind === QuorumKind.Groups)
      return step.quorum.groups.flatMap((group) => stepClassesOf(group.path.steps));
    return step.kind === StepKind.ChooseOne ? step.routes.map((route) => route.target) : [];
  });
}

/** Every node class a flow names: its sources and the targets of every step, side paths included. */
export function flowClassesOf(flow: readonly FlowPath[]): readonly Class[] {
  return flow.flatMap((path) => [path.source.node, ...stepClassesOf(path.steps)]);
}

/**
 * The workflow classes a flow launches: `.toWorkflow(W)`, `route(W)`, `.toParallelWorkflows(W, …)` —
 * never `ThisWorkflow` (#264), which is the workflow itself.
 */
export const childClassesOf = (flow: readonly FlowPath[]): readonly Class[] =>
  flowClassesOf(flow).filter(
    (target) => declarationOf(target)?.kind === NodeKind.Workflow && !isThisWorkflow(target),
  );

/** The workflows and, depth first, every child workflow they launch, each once. */
export function withChildWorkflows(workflows: readonly Class[]): readonly Class[] {
  const found = new Set<Class>();
  const visit = (workflow: Class): void => {
    if (found.has(workflow)) return;
    found.add(workflow);
    const declaration = declarationOf(workflow);
    if (declaration?.kind === NodeKind.Workflow)
      childClassesOf(declaration.options.flow).forEach(visit);
  };
  workflows.forEach(visit);
  return [...found];
}

/**
 * The workflows and every child workflow they launch, each once, every child before the workflows
 * that launch it (#336: a parent's `configHash` covers its children's, so they are built first).
 */
export function childrenFirst(workflows: readonly Class[]): readonly Class[] {
  const entered = new Set<Class>();
  const ordered: Class[] = [];
  const visit = (workflow: Class): void => {
    if (entered.has(workflow)) return;
    entered.add(workflow);
    const declaration = declarationOf(workflow);
    if (declaration?.kind === NodeKind.Workflow)
      childClassesOf(declaration.options.flow).forEach(visit);
    ordered.push(workflow);
  };
  workflows.forEach(visit);
  return ordered;
}

const summaries = new WeakMap<Class, ChildWorkflow>();

/** The child's starts and output; `undefined` for a class that is not a `@Workflow`. */
export function childWorkflowOf(workflow: Class): ChildWorkflow | undefined {
  const known = summaries.get(workflow);
  if (known !== undefined) return known;
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) return undefined;
  const child = summarise(declaration);
  summaries.set(workflow, child);
  return child;
}
