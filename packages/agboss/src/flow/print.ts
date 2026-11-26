import { ComponentKind } from "./runtime/records.js";
import type { Class } from "../components/injection.js";
import { sourceCallOf, toCallOf } from "./analyse/labels.js";
import {
  StepKind,
  type ChooseOneRoute,
  type FlowPath,
  type ForEachItemStep,
  type GroupsQuorum,
  type InParallelStep,
  type JoinStep,
  type OneOfStep,
  type ParallelBranchStep,
  type Step,
} from "./ast.js";
import { declarationOf } from "./decorators/declaration.js";
import { isLaunching } from "./launch-step.js";
import {
  arbitratedByLine,
  countQuorumOptions,
  groupsQuorumOptions,
  isGroupsQuorum,
} from "./print-quorum.js";

/**
 * The flow's paths printed in the grammar they are written in (#272 → Runtime: `agboss describe`,
 * Studio, the config fingerprint) — one call per line, nested steps indented. `label` names a
 * component: its class (`describe`) or its `name` (the fingerprint, stable across class renames).
 */

/** How a component is named in the printout. */
export type ComponentLabel = (component: Class) => string;

/** A component by its class name. */
export const byClassName: ComponentLabel = (component) => component.name || "(anonymous class)";

/** A component by its `name` (what records and checkpoints are keyed by). */
export const byComponentName: ComponentLabel = (component) =>
  declarationOf(component)?.options.name ?? byClassName(component);

class Printer {
  readonly lines: string[] = [];

  constructor(private readonly label: ComponentLabel) {}

  /** The steps of a path or a sub-path, `depth` levels in. */
  steps(steps: readonly Step[], depth: number): void {
    for (const step of steps) this.step(step, depth);
  }

  /** Appends to the last line: a `,` between branches, the `)` of a side path. */
  private closeLast(text: string): void {
    const last = this.lines.pop();
    this.lines.push(`${last ?? ""}${text}`);
  }

  private line(depth: number, text: string): void {
    this.lines.push(`${"  ".repeat(depth)}${text}`);
  }

  /** A branch (a `.toOneOf([…])` branch) as its first call and its steps. */
  private branch(head: string, steps: readonly Step[], depth: number, last: boolean): void {
    this.line(depth, head);
    this.steps(steps, depth + 1);
    if (!last) this.closeLast(",");
  }

  /** `.onRoute(toAgent(A)` and the route's other steps, closed on its last line (#1278). */
  private route(route: ChooseOneRoute, depth: number): void {
    const kind = declarationOf(route.target)?.kind ?? ComponentKind.Agent;
    this.line(depth, `.onRoute(${toCallOf(kind)}(${this.label(route.target)})`);
    this.steps(route.path.steps, depth + 1);
    this.closeLast(")");
  }

  /** `.onError(E, toAction(X)` and the side path's other steps, closed on its last line. */
  private sidePath(error: string, steps: readonly Step[], depth: number, call: string): void {
    const [first, ...rest] = steps;
    const head =
      first?.kind === StepKind.To
        ? `${toCallOf(first.targetKind)}(${this.label(first.target)})`
        : "";
    this.line(depth, `.${call}(${error}, ${head}`);
    this.steps(first?.kind === StepKind.To ? rest : steps, depth + 1);
    this.closeLast(")");
  }

  /** `.arbitratedBy(A)` of a launch (#1282). */
  private arbiter(step: InParallelStep | ForEachItemStep, depth: number): void {
    if (step.arbitratedBy !== undefined)
      this.line(depth, arbitratedByLine(step.arbitratedBy, this.label));
  }

  /** One branch of `.inParallel([…])`: `toAgent(A).onError(StepError, skip())`. */
  private parallelBranch(branch: ParallelBranchStep): string {
    const skips = branch.skip.map((error) => `.onError(${error.name}, skip())`).join("");
    const chosen = branch.chooses?.map((one) => this.parallelBranch(one)).join(", ");
    const picks = chosen === undefined ? "" : `.chooseMany([${chosen}])`;
    return `${toCallOf(branch.targetKind)}(${this.label(branch.target)})${skips}${picks}`;
  }

  /** `.inParallel([toAgent(A), …], { maxConcurrency })` (#1279). */
  private inParallel(step: InParallelStep, depth: number): void {
    const branches = step.branches.map((branch) => this.parallelBranch(branch)).join(", ");
    const options =
      step.maxConcurrency === undefined
        ? ""
        : `, { maxConcurrency: ${String(step.maxConcurrency)} }`;
    this.line(depth, `.inParallel([${branches}]${options})`);
  }

  /** `.forEachItem(toAgent(A), { takeFirst: 4 })` (#1280). */
  private forEachItem(step: ForEachItemStep, depth: number): void {
    const options = [
      ...(step.maxItems === undefined ? [] : [`maxItems: ${String(step.maxItems)}`]),
      ...(step.takeFirst === undefined ? [] : [`takeFirst: ${String(step.takeFirst)}`]),
      ...(step.maxConcurrency === undefined
        ? []
        : [`maxConcurrency: ${String(step.maxConcurrency)}`]),
    ];
    this.line(
      depth,
      `.forEachItem(${this.parallelBranch(step.branch)}, { ${options.join(", ")} })`,
    );
  }

  private launching(step: InParallelStep | ForEachItemStep, depth: number): void {
    if (step.kind === StepKind.InParallel) this.inParallel(step, depth);
    else this.forEachItem(step, depth);
    this.arbiter(step, depth);
  }

  /** `.joinQuorumGroups({ deadline })`; its groups follow its `.onError(…)` as `.onGroup(…)` (#1284). */
  private groupsJoin(quorum: GroupsQuorum, depth: number): void {
    this.line(depth, `.joinQuorumGroups(${groupsQuorumOptions(quorum, this.label) ?? ""})`);
  }

  /** `.onGroup([A, B], { priority: 1 }, toAgent(X)…)` of each group, in the order written. */
  private groups(quorum: GroupsQuorum, depth: number): void {
    for (const group of quorum.groups) {
      const targets = group.targets.map((target) => this.label(target)).join(", ");
      const priority =
        group.priority === undefined ? "" : `, { priority: ${String(group.priority)} }`;
      this.sidePath(`[${targets}]${priority}`, group.path.steps, depth, "onGroup");
    }
  }

  /** `.join()` / `.joinQuorum(…)` / `.joinQuorumGroups(…)`, its `.onError(…)` and, for groups, its `.onGroup(…)`s. */
  private join(step: JoinStep, depth: number): void {
    const { quorum } = step;
    if (isGroupsQuorum(quorum)) this.groupsJoin(quorum, depth);
    else
      this.line(
        depth,
        quorum === undefined ? ".join()" : `.joinQuorum(${countQuorumOptions(quorum, this.label)})`,
      );
    for (const handler of step.onError)
      this.sidePath(handler.error.name, handler.path.steps, depth, "onError");
    if (isGroupsQuorum(quorum)) this.groups(quorum, depth);
  }

  /** `.toOneOf([` each branch as a side path `])` (#1275). */
  private oneOf(step: OneOfStep, depth: number): void {
    this.line(depth, ".toOneOf([");
    for (const branch of step.branches) {
      const [first, ...rest] = branch.steps;
      const head =
        first?.kind === StepKind.To
          ? `${toCallOf(first.targetKind)}(${this.label(first.target)})`
          : "";
      this.branch(head, first?.kind === StepKind.To ? rest : branch.steps, depth + 1, false);
    }
    this.line(depth, "])");
  }

  private step(step: Step, depth: number): void {
    if (isLaunching(step)) {
      this.launching(step, depth);
      return;
    }
    switch (step.kind) {
      case StepKind.To:
        this.line(depth, `.${toCallOf(step.targetKind)}(${this.label(step.target)})`);
        return;
      case StepKind.OneOf:
        this.oneOf(step, depth);
        return;
      case StepKind.ChooseOne:
        for (const route of step.routes) this.route(route, depth);
        return;
      case StepKind.OnFinish:
        this.sidePath(this.label(step.finish), step.path.steps, depth, "onFinish");
        return;
      case StepKind.OnError:
        this.sidePath(step.error.name, step.path.steps, depth, "onError");
        return;

      case StepKind.Join:
        this.join(step, depth);
        return;
    }
  }
}

/** One path as lines: its source, then its steps indented. */
export function pathLines(path: FlowPath, label: ComponentLabel = byClassName): readonly string[] {
  const printer = new Printer(label);
  printer.lines.push(`${sourceCallOf(path.source.kind)}(${label(path.source.node)})`);
  printer.steps(path.steps, 1);
  return printer.lines;
}

/** Every path of a flow, in the order written. */
export const flowLines = (
  flow: readonly FlowPath[],
  label: ComponentLabel = byClassName,
): readonly string[] => flow.flatMap((path) => pathLines(path, label));
