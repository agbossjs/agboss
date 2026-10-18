import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { launchLabel } from "../join-groups.js";
import type { AnalysisContext } from "./context.js";

/**
 * `.onError(E, …)` stands right after the step that throws (#272 AC7); several per step, one per
 * class: a second handler for the same class on one step → `[flow.duplicate-error-handler]`. The
 * same holds for the `.onJoinError(E, …)` handlers of one join (#273).
 */

/** One handler: where it stands (a step, or a join) and the class it catches. */
interface Handler {
  readonly node: string;
  readonly site: string;
  readonly call: string;
  readonly error: string;
}

function duplicates(handlers: readonly Handler[]): readonly RuleViolation[] {
  const seen = new Map<string, { readonly handler: Handler; count: number }>();
  for (const handler of handlers) {
    const key = `${handler.site}\u0000${handler.call}\u0000${handler.error}`;
    const found = seen.get(key);
    if (found === undefined) seen.set(key, { handler, count: 1 });
    else found.count += 1;
  }
  return [...seen.values()]
    .filter(({ count }) => count > 1)
    .map(({ handler, count }) => {
      const { site, call, error, node } = handler;
      const message =
        `${site} has ${String(count)} handlers for ${error} — one .${call}(${error}, …) per ` +
        `class on ${call === "onError" ? "a step" : "a join"}`;
      return violation("flow.duplicate-error-handler", message, [node]);
    });
}

export function errorRules(context: AnalysisContext): readonly RuleViolation[] {
  const steps = context.walked.errorHandlers.map((found): Handler => ({
    node: found.node,
    site: found.node,
    call: "onError",
    error: found.step.error.name,
  }));
  const joins = context.walked.joinErrorHandlers.map((found): Handler => ({
    node: found.node,
    site: `the join of ${launchLabel(found.launch)}`,
    call: "onJoinError",
    error: found.handler.error.name,
  }));
  return duplicates([...steps, ...joins]);
}
