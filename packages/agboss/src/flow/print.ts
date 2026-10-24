import type { Class } from "../components/injection.js";
import { aboutLabel, shapeLabel } from "./analyse/labels.js";
import {
  NodeKind,
  StepKind,
  type FlowPath,
  type GroupsQuorum,
  type JoinStep,
  type LaunchStep,
  type PathSource,
  type ReturnedValue,
  type Step,
} from "./ast.js";
import { declarationOf } from "./decorators/declaration.js";
import { LAUNCH_CALLS } from "./launch-step.js";
import { ChildPlacement } from "./child-placement.js";
import {
  acceptedByLine,
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

const TO_CALL: Readonly<Record<NodeKind, string>> = {
  [NodeKind.Agent]: "toAgent",
  [NodeKind.Router]: "toRouter",
  [NodeKind.Action]: "toAction",
  [NodeKind.Finish]: "toFinish",
  [NodeKind.Workflow]: "toWorkflow",
  [NodeKind.Start]: "start",
};

const sourceCall = (source: PathSource): string =>
  source.kind === NodeKind.Start ? "start" : source.kind;

/** `XDto`, `XDto, { about: PlanDto }` — a `.returns(…)` or a `caseOf(…)`'s arguments. */
const valueText = (value: Pick<ReturnedValue, "about"> & { readonly label: string }): string =>
  value.about === undefined ? value.label : `${value.label}, ${aboutLabel(value.about)}`;

const returnsLine = (value: ReturnedValue): string =>
  `.returns(${valueText({ ...value, label: shapeLabel(value.shape) })})`;

/** The enum member's name of a placement: `AnyInstance`. */
const placementName = (placement: ChildPlacement): string =>
  placement === ChildPlacement.AnyInstance ? "AnyInstance" : "ParentInstance";

/** `placement: ChildPlacement.AnyInstance` (#333 PR 2), as written; none without one. */
const placementOption = (placement: ChildPlacement | undefined): readonly string[] =>
  placement === undefined ? [] : [`placement: ChildPlacement.${placementName(placement)}`];

/** `, { placement: ChildPlacement.AnyInstance }` of a child step; empty without one. */
const childOptions = (placement: ChildPlacement | undefined): string => {
  const options = placementOption(placement);
  return options.length === 0 ? "" : `, { ${options.join(", ")} }`;
};

/** `{ maxConcurrency: 3, maxItems: 50 }`, as written; empty without options. */
function launchOptions(step: LaunchStep): string {
  const options = [
    ...(step.maxConcurrency === undefined
      ? []
      : [`maxConcurrency: ${String(step.maxConcurrency)}`]),
    ...(step.maxItems === undefined ? [] : [`maxItems: ${String(step.maxItems)}`]),
    ...placementOption(step.placement),
  ];
  return options.length === 0 ? "" : `, { ${options.join(", ")} }`;
}

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

  /** A branch (`route(…)`, `caseOf(…)`, a side path) as its first call and its steps. */
  private branch(head: string, steps: readonly Step[], depth: number, last: boolean): void {
    this.line(depth, head);
    this.steps(steps, depth + 1);
    if (!last) this.closeLast(",");
  }

  /** `.onError(E, toAction(X)` and the side path's other steps, closed on its last line. */
  private sidePath(error: string, steps: readonly Step[], depth: number, call: string): void {
    const [first, ...rest] = steps;
    const head =
      first?.kind === StepKind.To
        ? `${TO_CALL[first.targetKind]}(${this.label(first.target)}${childOptions(first.placement)})`
        : "";
    this.line(depth, `.${call}(${error}, ${head}`);
    this.steps(first?.kind === StepKind.To ? rest : steps, depth + 1);
    this.closeLast(")");
  }

  /** `.toParallelAgents(A, B, { maxConcurrency: 3 })` (#273). */
  private launch(step: LaunchStep, depth: number): void {
    const targets = step.targets.map((target) => this.label(target)).join(", ");
    this.line(depth, `.${LAUNCH_CALLS[step.targetKind]}(${targets}${launchOptions(step)})`);
    for (const accepted of step.acceptedBy ?? [])
      this.line(depth, acceptedByLine(accepted, this.label));
  }

  /** `.joinQuorumGroups(` each `group(…)` with its priority, values and path, its options `)` (#279). */
  private groups(quorum: GroupsQuorum, depth: number): void {
    this.line(depth, ".joinQuorumGroups(");
    const options = groupsQuorumOptions(quorum);
    quorum.groups.forEach((group, index) => {
      this.line(depth + 1, `group(${group.agents.map((agent) => this.label(agent)).join(", ")})`);
      if (group.priority !== undefined)
        this.line(depth + 2, `.priority(${String(group.priority)})`);
      for (const value of group.returns) this.line(depth + 2, returnsLine(value));
      this.steps(group.path.steps, depth + 2);
      if (index < quorum.groups.length - 1 || options !== undefined) this.closeLast(",");
    });
    if (options !== undefined) this.line(depth + 1, options);
    this.line(depth, ")");
  }

  /** `.join()` / `.joinQuorum(…)` / `.joinQuorumGroups(…)`, its `.onJoinError(…)`, its `.returns(…)`. */
  private join(step: JoinStep, depth: number): void {
    const { quorum } = step;
    if (isGroupsQuorum(quorum)) this.groups(quorum, depth);
    else
      this.line(
        depth,
        quorum === undefined ? ".join()" : `.joinQuorum(${countQuorumOptions(quorum)})`,
      );
    for (const handler of step.onJoinError)
      this.sidePath(handler.error.name, handler.path.steps, depth, "onJoinError");
    for (const value of step.returns) this.line(depth, returnsLine(value));
  }

  private step(step: Step, depth: number): void {
    switch (step.kind) {
      case StepKind.Returns:
        this.line(depth, returnsLine(step.value));
        return;
      case StepKind.To:
        this.line(
          depth,
          `.${TO_CALL[step.targetKind]}(${this.label(step.target)}${childOptions(step.placement)})`,
        );
        return;
      case StepKind.Switch:
        this.line(depth, ".switch(");
        step.cases.forEach((branch, index) => {
          const head = `caseOf(${valueText({ ...branch, label: branch.dto.name })})`;
          this.branch(head, branch.path.steps, depth + 1, index === step.cases.length - 1);
        });
        this.line(depth, ")");
        return;
      case StepKind.ChooseOne:
        this.line(depth, ".chooseOne(");
        step.routes.forEach((route, index) => {
          const head = `route(${this.label(route.target)}${childOptions(route.placement)})`;
          this.branch(head, route.path.steps, depth + 1, index === step.routes.length - 1);
        });
        this.line(depth, ")");
        return;
      case StepKind.OnError:
        this.sidePath(step.error.name, step.path.steps, depth, "onError");
        return;
      case StepKind.Launch:
        this.launch(step, depth);
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
  printer.lines.push(`${sourceCall(path.source)}(${label(path.source.node)})`);
  printer.steps(path.steps, 1);
  return printer.lines;
}

/** Every path of a flow, in the order written. */
export const flowLines = (
  flow: readonly FlowPath[],
  label: ComponentLabel = byClassName,
): readonly string[] => flow.flatMap((path) => pathLines(path, label));
