import type { Class } from "../components/injection.js";
import { TokenLimit } from "../config/types.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { isDecisionModel } from "../models/decision-models.js";
import { compactionMetaOf, isSummarising, type CompactionMeta } from "./compaction.decorator.js";

/**
 * The assembly checks of a `@Compaction` class (#120 AC10): its name ends with `-compaction`; a
 * compaction that writes summaries names a chat model (a decision model gives no text) and whole
 * numbers from 1 for `turnsBetweenCompactions`, `summaryQueueLength` (a queue) and
 * `summaryMaxTokens` (or `TokenLimit.MODEL_MAX`). That `SummaryQueue` and `SingleSummary` need a `model` and
 * `None` takes nothing is the decorator's type; these are what a type cannot say.
 */

const SUFFIX = "-compaction";

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

function settingViolations(cls: Class, meta: CompactionMeta): RuleViolation[] {
  if (!isSummarising(meta)) return [];
  const bad = (field: string, value: unknown, what: string): RuleViolation =>
    violation("compaction.invalid-setting", `${meta.name}: ${field} ${String(value)} — ${what}`, [
      cls.name,
    ]);
  const found: RuleViolation[] = [];
  if (!isCount(meta.turnsBetweenCompactions))
    found.push(
      bad("turnsBetweenCompactions", meta.turnsBetweenCompactions, "a whole number from 1"),
    );
  if (meta.summaryMaxTokens !== TokenLimit.MODEL_MAX && !isCount(meta.summaryMaxTokens))
    found.push(
      bad(
        "summaryMaxTokens",
        meta.summaryMaxTokens,
        "a whole number from 1, or TokenLimit.MODEL_MAX",
      ),
    );
  if (meta.summaryQueueLength !== undefined && !isCount(meta.summaryQueueLength))
    found.push(bad("summaryQueueLength", meta.summaryQueueLength, "a whole number from 1"));
  if (isDecisionModel(meta.model))
    found.push(
      violation(
        "compaction.decision-model",
        `${meta.name}: ${meta.model} is a decision model — a summary is written by a chat model`,
        [cls.name],
      ),
    );
  return found;
}

/** Every rule the compaction classes break, all at once. */
export function compactionViolations(classes: readonly Class[]): RuleViolation[] {
  return classes.flatMap((cls) => {
    const meta = compactionMetaOf(cls);
    if (meta === undefined) return [];
    const name = meta.name.endsWith(SUFFIX)
      ? []
      : [
          violation("name.kind-suffix", `${meta.name}: a compaction's name ends with ${SUFFIX}`, [
            cls.name,
          ]),
        ];
    return [...name, ...settingViolations(cls, meta)];
  });
}
