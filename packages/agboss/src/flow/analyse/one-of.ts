import type { DtoClass } from "../../dto/types.js";
import { NodeKind, StepKind, type OneOfStep, type SubPath, type ToStep } from "../ast.js";
import {
  declarationOf,
  type ComponentDeclaration,
  type InputFieldShape,
} from "../decorators/declaration.js";
import { Wrapper } from "../dto-wrappers.js";
import { childWorkflowOf } from "./child-workflow.js";
import { TEXT_AGENT_INPUT } from "./fields.js";
import { classLabel, dtoLabel, toCallOf } from "./labels.js";

/**
 * Which variant of a `oneOf(…)` each branch of `.toOneOf([…])` takes (#1275). A branch names no DTO:
 * it takes the variant its entry consumer reads — the `input` of its first agent, action, router or
 * `@ExternalTask`, the `output` of a `toFinish`, the start input of a child workflow — past
 * leading actions that read nothing. A branch whose consumer reads no variant is the one fallback:
 * when `N − 1` branches claim `N − 1` variants it takes the one left (`N − 1` elimination).
 */

/** What went wrong with the branches of one `.toOneOf([…])`. */
export enum OneOfProblem {
  /** A variant no branch takes. */
  Missing = "missing",
  /** A branch that reads several variants, a variant read by several branches, or a branch that reads none and has no variant left. */
  Ambiguous = "ambiguous",
}

export interface OneOfFinding {
  readonly problem: OneOfProblem;
  readonly message: string;
}

export interface OneOfResolution {
  /** The variant of each branch, in order; `undefined` where it could not be decided. */
  readonly variants: readonly (DtoClass | undefined)[];
  readonly findings: readonly OneOfFinding[];
}

/** The class an input field reads one value of; a list, which no single variant fills, reads none. */
function dtoOfField(shape: InputFieldShape): DtoClass | undefined {
  if (typeof shape === "function") return shape;
  switch (shape.kind) {
    case Wrapper.Optional:
      return dtoOfField(shape.inner);
    case Wrapper.History:
      return shape.dto;
    default:
      return undefined;
  }
}

const classesOf = (shapes: readonly InputFieldShape[]): readonly DtoClass[] =>
  shapes.flatMap((shape) => dtoOfField(shape) ?? []);

/** The fields a declaration reads from the path; `undefined` for one that reads nothing. */
function fieldShapesOf(declaration: ComponentDeclaration): readonly InputFieldShape[] | undefined {
  switch (declaration.kind) {
    case NodeKind.Agent:
      return Object.values(declaration.options.input ?? TEXT_AGENT_INPUT);
    case NodeKind.Action:
    case NodeKind.Router:
    case NodeKind.Question: {
      const { input } = declaration.options;
      return input === undefined ? undefined : Object.values(input);
    }
    case NodeKind.Finish:
      return [declaration.options.output];
    default:
      return undefined;
  }
}

/** What a child workflow's starts read: every field of every start. */
const childReads = (step: ToStep): readonly DtoClass[] => {
  const child = childWorkflowOf(step.target);
  return child === undefined
    ? []
    : classesOf(child.starts.flatMap((start) => start.fields.map((field) => field.shape)));
};

/** The classes the first consumer of a branch reads; leading actions that read nothing are skipped. */
function entryReads(path: SubPath): readonly DtoClass[] {
  for (const step of path.steps) {
    if (step.kind !== StepKind.To) return [];
    if (step.targetKind === NodeKind.Workflow) return childReads(step);
    const declaration = declarationOf(step.target);
    const shapes = declaration === undefined ? undefined : fieldShapesOf(declaration);
    const readsNothing =
      declaration?.kind === NodeKind.Action && (shapes === undefined || shapes.length === 0);
    if (!readsNothing) return classesOf(shapes ?? []);
  }
  return [];
}

/** How a message names a branch: its first step, `toAction(SaveAction)`, or its place. */
function branchLabel(path: SubPath, index: number): string {
  const [first] = path.steps;
  return first?.kind === StepKind.To
    ? `${toCallOf(first.targetKind)}(${classLabel(first.target)})`
    : `branch ${String(index + 1)}`;
}

/** Decides every branch's variant of `step` after a step that gives `variants`. */
export function resolveOneOf(variants: readonly DtoClass[], step: OneOfStep): OneOfResolution {
  const claims = step.branches.map((path) => variants.filter((v) => entryReads(path).includes(v)));
  const findings: OneOfFinding[] = [];
  const taken = new Map<DtoClass, number[]>();
  claims.forEach((claimed, index) => {
    const label = branchLabel(step.branches[index] ?? { steps: [] }, index);
    if (claimed.length > 1) {
      const names = claimed.map(dtoLabel).join(" and ");
      const message = `${label} reads ${names}, variants of one oneOf — a branch takes exactly one`;
      findings.push({ problem: OneOfProblem.Ambiguous, message });
    }
    for (const variant of claimed.length === 1 ? claimed : [])
      taken.set(variant, [...(taken.get(variant) ?? []), index]);
  });
  for (const [variant, branches] of taken) {
    if (branches.length < 2) continue;
    const labels = branches.map((at) => branchLabel(step.branches[at] ?? { steps: [] }, at));
    const message = `${labels.join(" and ")} both read ${dtoLabel(variant)} — a variant has one branch`;
    findings.push({ problem: OneOfProblem.Ambiguous, message });
  }
  const unclaimed = variants.filter(
    (variant) => !claims.some((claimed) => claimed.includes(variant)),
  );
  const loose = claims.flatMap((claimed, index) => (claimed.length === 0 ? [index] : []));
  const [fallback] = loose;
  const isEliminated = loose.length === 1 && unclaimed.length === 1 && fallback !== undefined;
  if (!isEliminated) reportRest(step, unclaimed, loose, findings);
  const assigned = claims.map((claimed, index): DtoClass | undefined => {
    if (claimed.length === 1) return claimed[0];
    return isEliminated && index === fallback ? unclaimed[0] : undefined;
  });
  return { variants: assigned, findings };
}

/** What is left over when the branches do not fit the variants one to one. */
function reportRest(
  step: OneOfStep,
  unclaimed: readonly DtoClass[],
  loose: readonly number[],
  findings: OneOfFinding[],
): void {
  if (loose.length === 0) {
    for (const variant of unclaimed) {
      const message = `no branch reads ${dtoLabel(variant)} — add one whose first step takes it as input`;
      findings.push({ problem: OneOfProblem.Missing, message });
    }
    return;
  }
  const names = unclaimed.map(dtoLabel).join(", ");
  const left = unclaimed.length === 0 ? "no variant is left" : `${names} are left`;
  for (const at of loose) {
    const label = branchLabel(step.branches[at] ?? { steps: [] }, at);
    const message =
      `${label} reads no variant and ${left} for it — one branch may read none (it takes the ` +
      "variant left), for condition-based routing use .toRouter(R).onRoute(…)";
    findings.push({ problem: OneOfProblem.Ambiguous, message });
  }
}
