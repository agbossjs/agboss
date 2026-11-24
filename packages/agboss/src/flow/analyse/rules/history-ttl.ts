import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { shownLimit } from "../../../graph/count-limit.js";
import { Ttl } from "../../../units/index.js";
import type { AnalysisContext } from "./context.js";

/**
 * `[limits.history-ttl-invalid]` (#1318): `@Workflow({ historyTtl })` is a duration above 0, `Ttl.Forever`
 * or `Ttl.None`. A value that is none of them — `NaN`, a negative number, `0`, a word — would sweep
 * every history row at once or never, so assembly refuses it. A profile's value is checked when the
 * profile is loaded; this is the one the decorator declares.
 */
export function historyTtlRules(context: AnalysisContext): readonly RuleViolation[] {
  const { historyTtl, name } = context.workflow;
  if (historyTtl === undefined || historyTtl === Ttl.Forever || historyTtl === Ttl.None) return [];
  if (typeof historyTtl === "number" && Number.isFinite(historyTtl) && historyTtl > 0) return [];
  const message =
    `${name} has historyTtl: ${shownLimit(historyTtl)}, not a duration above 0, Ttl.Forever or Ttl.None — ` +
    "@Workflow({ historyTtl: days(90) }) keeps the history of its finished executions for 90 days";
  return [violation("limits.history-ttl-invalid", message, [name])];
}
