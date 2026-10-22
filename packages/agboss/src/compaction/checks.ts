import type { Class } from "../components/injection.js";
import { TokenLimit } from "../config/types.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { isDecisionModel } from "../models/decision-models.js";
import {
  compactionMetaOf,
  isCustomCompaction,
  isSummarising,
  type CompactionMeta,
} from "./compaction.decorator.js";

/**
 * The assembly checks of a `@Compaction` class (#120 AC10): its name ends with `-compaction`; a
 * compaction that writes summaries names a chat model (a decision model gives no text) and whole
 * numbers from 1 for `turnsBetweenCompactions`, `summaryQueueLength` (a queue) and
 * `summaryMaxTokens` (or `TokenLimit.MODEL_MAX`). That `SummaryQueue` and `SingleSummary` need a `model` and
 * `None` takes nothing is the decorator's type; these are what a type cannot say. A custom one
 * (#382) has a `compact` method (`[compaction.missing-handler]`), a whole number from 1 for
 * `turnsBetweenCompactions` and none of a model's settings — the decorator's overloads say so, these
 * rules hold for a class the compiler did not check.
 */

const SUFFIX = "-compaction";

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/** A broken setting of `meta`: `field value — what it must be`. */
const badSetting =
  (cls: Class, meta: CompactionMeta) =>
  (field: string, value: unknown, what: string): RuleViolation =>
    violation("compaction.invalid-setting", `${meta.name}: ${field} ${String(value)} — ${what}`, [
      cls.name,
    ]);

/** What a model's compaction sets and a custom one does not take. */
const MODEL_SETTINGS = ["model", "prompt", "promptUrls", "summaryMaxTokens", "summaryQueueLength"];

/** A custom compaction (#382): its `compact` method, its count, no model's settings. */
function customViolations(cls: Class, meta: CompactionMeta): RuleViolation[] {
  const bad = badSetting(cls, meta);
  const found: RuleViolation[] = [];
  const compact: unknown = Reflect.get(cls.prototype as object, "compact");
  if (typeof compact !== "function") {
    const message = `${cls.name} (${meta.name}) is CompactionStrategy.Custom but has no compact(input) method — implements CompactionHandler`;
    found.push(violation("compaction.missing-handler", message, [cls.name]));
  }
  if (!isCount(meta.turnsBetweenCompactions))
    found.push(
      bad("turnsBetweenCompactions", meta.turnsBetweenCompactions, "a whole number from 1"),
    );
  for (const field of MODEL_SETTINGS) {
    const value: unknown = Reflect.get(meta, field);
    if (value !== undefined) found.push(bad(field, value, "CompactionStrategy.Custom takes none"));
  }
  return found;
}

function settingViolations(cls: Class, meta: CompactionMeta): RuleViolation[] {
  if (isCustomCompaction(meta)) return customViolations(cls, meta);
  if (!isSummarising(meta)) return [];
  const bad = badSetting(cls, meta);
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
