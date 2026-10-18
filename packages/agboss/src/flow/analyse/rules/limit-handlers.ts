import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { LimitExceededError } from "../../../graph/limits.js";
import { NodeKind, type ErrorClass } from "../../ast.js";
import type { ComponentName } from "../../registry.js";
import { EdgeKind, reachableFrom, type FlowEdge } from "../flow-graph.js";
import { launchLabel } from "../join-groups.js";
import type { AnalysisContext } from "./context.js";

/**
 * No model call after a limit (#263, #272): an `.onError` / `.onJoinError` side path that can catch
 * a `LimitExceededError` — the class, a subclass (`BudgetExceededError`, `VisitsLimitExceededError`,
 * …) or a parent (`AGBossError`, `Error`) — leads only to actions and finishes, never paying past
 * the limit; one that reaches an agent, a router or a child workflow →
 * `[graph.limit-handler-uses-model]`. A child's own limit reaches its parent as
 * `ChildExecutionFailedError` (S25), so a handler of that class may lead to an agent.
 */

/** Whether `first` is `second` or one of its subclasses. */
function extendsClass(first: ErrorClass, second: ErrorClass): boolean {
  for (let current: unknown = first; typeof current === "function";) {
    if (current === second) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

/** Whether a handler of `error` can take a limit: it is a limit's class, subclass or parent. */
export const catchesLimit = (error: ErrorClass): boolean =>
  extendsClass(error, LimitExceededError) || extendsClass(LimitExceededError, error);

const SPENDS_NOTHING: ReadonlySet<NodeKind> = new Set([NodeKind.Action, NodeKind.Finish]);

/** One side path catching a limit: where it stands, and its first nodes. */
interface LimitHandler {
  readonly site: string;
  readonly node: ComponentName;
  readonly call: string;
  readonly error: ErrorClass;
  readonly entered: readonly ComponentName[];
}

function handlerViolation(context: AnalysisContext, handler: LimitHandler): RuleViolation[] {
  const { graph } = context;
  const reached = [...reachableFrom(handler.entered, graph.edges)].filter((name) => {
    const kind = graph.nodes.get(name)?.kind;
    return kind !== undefined && !SPENDS_NOTHING.has(kind);
  });
  if (reached.length === 0) return [];
  const message =
    `${handler.site}: .${handler.call}(${handler.error.name}, …) can catch a limit and reaches ` +
    `${reached.sort().join(", ")} — after a limit a side path leads only to actions and finishes ` +
    "(no model call past a limit); catch a narrower class, or end the side path with toAction(…) / toFinish(…)";
  return [violation("graph.limit-handler-uses-model", message, [handler.node, ...reached])];
}

const targetsOf = (edges: readonly FlowEdge[], match: (edge: FlowEdge) => boolean) =>
  edges.filter(match).map((edge) => edge.to);

function limitHandlers(context: AnalysisContext): readonly LimitHandler[] {
  const { edges } = context.graph;
  const steps = context.walked.errorHandlers.map(({ node, step }) => ({
    site: node,
    node,
    call: "onError",
    error: step.error,
    entered: targetsOf(
      edges,
      (edge) => edge.kind === EdgeKind.Error && edge.from === node && edge.error === step.error,
    ),
  }));
  const joins = context.walked.joinErrorHandlers.map(({ node, launch, handler }) => ({
    site: `the join of ${launchLabel(launch)}`,
    node,
    call: "onJoinError",
    error: handler.error,
    entered: targetsOf(
      edges,
      (edge) =>
        edge.kind === EdgeKind.JoinError && edge.launch === launch && edge.error === handler.error,
    ),
  }));
  return [...steps, ...joins].filter((handler) => catchesLimit(handler.error));
}

export function limitHandlerRules(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const handler of limitHandlers(context))
    for (const problem of handlerViolation(context, handler)) found.set(problem.message, problem);
  return [...found.values()];
}
