import { violation, type RuleViolation } from "../../graph/rule-error.js";
import {
  NodeKind,
  StepKind,
  type ChooseOneStep,
  type ErrorClass,
  type FlowPath,
  type JoinStep,
  type LaunchStep,
  type OnErrorStep,
  type PathSource,
  type ReturnsStep,
  type Step,
  type SwitchStep,
  type ToStep,
} from "../ast.js";
import { Wrapper, type OneOfWrapper } from "../dto-wrappers.js";
import { declarationOf } from "../decorators/declaration.js";
import type { ComponentName } from "../registry.js";
import {
  EdgeKind,
  edgeKey,
  valueWrite,
  writesLeaving,
  type FlowEdge,
  type FlowGraph,
  type FlowLaunch,
  type JoinEdge,
  type ValueWrite,
} from "./flow-graph.js";
import { dtoLabel } from "./labels.js";
import {
  MentionKind,
  type BranchSite,
  type JoinErrorSite,
  type Mention,
  type Placement,
  type SwitchSite,
  type WalkedFlow,
} from "./walked-flow.js";
import { NodeTable } from "./nodes.js";
import { itemWrites, joinEdgeOf, launchOf } from "./walk-launch.js";

/**
 * Walks the paths of a flow once (#272 PR 2): builds the graph (nodes, edges with what each step
 * returns), and records what the syntactic rules read — where every node is mentioned (placement),
 * how deep (depth), and every `switch` / `chooseOne` / `onError` with the node it follows.
 */

/** Where a walk stands: the node the next step follows, and what the edge to the next node carries. */
interface Cursor {
  readonly current: ComponentName | undefined;
  readonly writes: readonly ValueWrite[];
  /** A `.returns(oneOf(…))` the next `.switch(…)` branches (#299 S54 c). */
  readonly oneOf?: OneOfWrapper;
  readonly entry: EdgeKind;
  readonly error?: ErrorClass;
  readonly depth: number;
  readonly path: PathSource;
  /** A launch waiting for its join, then a join waiting for its `.to…(…)` (#273). */
  readonly launch?: FlowLaunch;
  readonly join?: JoinEdge;
}

class FlowWalker {
  readonly table = new NodeTable();
  readonly edges: FlowEdge[] = [];
  readonly starts: ComponentName[] = [];
  readonly mentions: Mention[] = [];
  readonly placements: Placement[] = [];
  readonly switches: SwitchSite[] = [];
  readonly choices: BranchSite<ChooseOneStep>[] = [];
  readonly errorHandlers: BranchSite<OnErrorStep>[] = [];
  readonly launches: FlowLaunch[] = [];
  readonly joinErrorHandlers: JoinErrorSite[] = [];
  readonly violations: RuleViolation[] = [];

  walkPath(path: FlowPath): void {
    const source = this.table.resolve(path.source.node, path.source.kind);
    if (source !== undefined) {
      this.placements.push({ node: source, depth: 0, path: path.source });
      if (path.source.kind === NodeKind.Start) this.starts.push(source);
      else this.mentions.push({ node: source, kind: MentionKind.OwnPath, isContinued: true });
    }
    this.walkSteps(path.steps, nextCursor(source, 0, path.source));
  }

  /** Walks a step list; returns whether it reached a node of its own (a `.to…` step). */
  private walkSteps(steps: readonly Step[], start: Cursor): boolean {
    let cursor = start;
    steps.forEach((step, index) => {
      cursor = this.walkStep(step, cursor, index < steps.length - 1);
    });
    if (cursor.launch !== undefined && cursor.join === undefined && cursor.current !== undefined) {
      const message = `${cursor.current}: a parallel launch is followed by .join() — the branches' values meet there`;
      this.violations.push(violation("launch.join-required", message, [cursor.current]));
    }
    return steps.some((step) => step.kind === StepKind.To);
  }

  /** One step; returns where the walk stands after it (every kind of step has its case). */
  private walkStep(step: Step, cursor: Cursor, isFollowed: boolean): Cursor {
    switch (step.kind) {
      case StepKind.Returns:
        return this.returns(step, cursor);
      case StepKind.To:
        return this.enter(step, cursor, isFollowed);
      case StepKind.Switch:
        this.walkSwitch(step, cursor);
        return cursor;
      case StepKind.ChooseOne:
        this.walkChooseOne(step, cursor);
        return cursor;
      case StepKind.OnError:
        this.walkOnError(step, cursor);
        return cursor;
      case StepKind.Launch:
        return this.walkLaunch(step, cursor);
      case StepKind.Join:
        return this.walkJoin(step, cursor);
    }
  }

  /**
   * A `.returns(…)`: its value travels on the next edge; a `oneOf` waits for its `.switch` (one
   * followed by a transition is the returns rule's `[flow.returns-mismatch]`).
   */
  private returns(step: ReturnsStep, cursor: Cursor): Cursor {
    const { shape, about } = step.value;
    if (typeof shape !== "function" && shape.kind === Wrapper.OneOf)
      return { ...cursor, oneOf: shape };
    return { ...cursor, writes: [...cursor.writes, valueWrite(shape, about, false)] };
  }

  private enter(step: ToStep, cursor: Cursor, isContinued: boolean): Cursor {
    const target = this.table.resolve(step.target, step.targetKind);
    if (target !== undefined) this.arrive(target, cursor, isContinued);
    return nextCursor(target, cursor.depth, cursor.path);
  }

  /** A mention of `target` reached from the cursor: its placement, mention and incoming edge. */
  private arrive(target: ComponentName, cursor: Cursor, isContinued: boolean): void {
    this.placements.push({ node: target, depth: cursor.depth, path: cursor.path });
    this.mentions.push({ node: target, kind: MentionKind.Entry, isContinued });
    if (isContinued && this.table.node(target).kind === NodeKind.Finish) {
      const message = `${target} is a finish — nothing follows .toFinish(…) or route(…) of a finish`;
      this.violations.push(violation("graph.next-after-workflow-finish", message, [target]));
    }
    const from = cursor.current;
    if (from === undefined || this.table.node(from).kind === NodeKind.Finish) return;
    const { entry: kind, error, launch, join } = cursor;
    const writes = writesLeaving(this.table.node(from), kind, cursor.writes);
    this.edges.push({
      from,
      to: target,
      kind,
      writes,
      ...(error === undefined ? {} : { error }),
      ...(launch === undefined ? {} : { launch }),
      ...(join === undefined ? {} : { join }),
    });
  }

  /** A launch: one edge to each distinct target, the scope at the launch (+ its item) on it. */
  private walkLaunch(step: LaunchStep, cursor: Cursor): Cursor {
    if (cursor.current === undefined) return cursor;
    const launch = launchOf(this.table, this.table.node(cursor.current), step, cursor.writes);
    if (launch === undefined) return cursor;
    this.launches.push(launch);
    for (const node of launch.listed) {
      this.placements.push({ node, depth: cursor.depth, path: cursor.path });
      this.mentions.push({ node, kind: MentionKind.Entry, isContinued: false });
    }
    const writes = [...cursor.writes, ...itemWrites(launch)];
    for (const branch of launch.branches)
      this.edges.push({ from: cursor.current, to: branch.node, kind: EdgeKind.Launch, writes, launch });
    return { ...cursor, launch };
  }

  /** A join: its `.onJoinError(…)` side paths, then the edge of the next `.to…(…)` (#273). */
  private walkJoin(step: JoinStep, cursor: Cursor): Cursor {
    const { current, launch } = cursor;
    if (current === undefined || launch === undefined) return cursor;
    for (const handler of step.onJoinError) {
      this.joinErrorHandlers.push({ node: current, launch, handler });
      const inner: Cursor = {
        ...cursor,
        entry: EdgeKind.JoinError,
        error: handler.error,
        depth: cursor.depth + 1,
      };
      if (this.walkSteps(handler.path.steps, inner)) continue;
      const message = `${current}: .onJoinError(${handler.error.name}, …) leads nowhere — start it with toAction(…) or toFinish(…)`;
      this.violations.push(violation("graph.dead-end", message, [current]));
    }
    const join = joinEdgeOf(launch, step, (name) => this.table.node(name));
    return { ...cursor, entry: EdgeKind.Join, join };
  }

  private walkSwitch(step: SwitchStep, cursor: Cursor): void {
    if (cursor.current === undefined) return;
    const { oneOf: returned } = cursor;
    this.switches.push({
      node: cursor.current,
      step,
      ...(returned === undefined ? {} : { returned }),
    });
    for (const branch of step.cases) {
      const inner: Cursor = {
        current: cursor.current,
        writes: [valueWrite(branch.dto, branch.about, true)],
        entry: EdgeKind.Case,
        path: cursor.path,
        depth: cursor.depth + 1,
      };
      if (!this.walkSteps(branch.path.steps, inner)) {
        const message = `${cursor.current}: caseOf(${dtoLabel(branch.dto)}) leads nowhere — continue it with .to…(…)`;
        this.violations.push(violation("graph.dead-end", message, [cursor.current]));
      }
    }
  }

  private walkChooseOne(step: ChooseOneStep, cursor: Cursor): void {
    if (cursor.current !== undefined) this.choices.push({ node: cursor.current, step });
    const depth = cursor.depth + 1;
    for (const route of step.routes) {
      const target = this.table.resolve(route.target, kindOfTarget(route.target));
      if (target === undefined) continue;
      this.arrive(target, { ...cursor, entry: EdgeKind.Route, depth }, route.path.steps.length > 0);
      this.walkSteps(route.path.steps, nextCursor(target, depth, cursor.path));
    }
  }

  private walkOnError(step: OnErrorStep, cursor: Cursor): void {
    if (cursor.current === undefined) return;
    this.errorHandlers.push({ node: cursor.current, step });
    const inner: Cursor = {
      ...cursor,
      writes: [],
      entry: EdgeKind.Error,
      error: step.error,
      depth: cursor.depth + 1,
    };
    if (!this.walkSteps(step.path.steps, inner)) {
      const message = `${cursor.current}: .onError(${step.error.name}, …) leads nowhere — start it with toAction(…) or toFinish(…)`;
      this.violations.push(violation("graph.dead-end", message, [cursor.current]));
    }
  }
}

/** Where a walk stands after a node is entered: nothing returned yet. */
const nextCursor = (
  current: ComponentName | undefined,
  depth: number,
  path: PathSource,
): Cursor => ({
  current,
  writes: [],
  entry: EdgeKind.Next,
  depth,
  path,
});

/** A route target's kind is the kind its class is declared with (the builder checked it). */
const kindOfTarget = (target: ToStep["target"]): NodeKind =>
  declarationOf(target)?.kind ?? NodeKind.Agent;

/** Walks every path of a flow. */
export function walkFlow(flow: readonly FlowPath[]): WalkedFlow {
  const walker = new FlowWalker();
  for (const path of flow) walker.walkPath(path);
  const edges = [...walker.edges].sort((first, second) =>
    edgeKey(first).localeCompare(edgeKey(second)),
  );
  const graph: FlowGraph = {
    nodes: walker.table.nodes,
    edges,
    starts: [...new Set(walker.starts)].sort(),
  };
  return {
    graph,
    mentions: walker.mentions,
    placements: walker.placements,
    switches: walker.switches,
    choices: walker.choices,
    errorHandlers: walker.errorHandlers,
    launches: walker.launches,
    joinErrorHandlers: walker.joinErrorHandlers,
    violations: [...walker.table.violations, ...walker.violations],
  };
}
