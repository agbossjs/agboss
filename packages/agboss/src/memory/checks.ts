import type { Class } from "../components/injection.js";
import { TokenLimit } from "../config/types.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { Ttl } from "../units/index.js";
import { isUncompactedTurns } from "./levels.js";
import {
  hasCompactMethod,
  memoryMetaOf,
  type MemoryCompaction,
  type MemoryMeta,
} from "./memory.decorator.js";

/**
 * The assembly checks of a `@Memory` class (#1303): its name ends with `-memory`; `ttl` is a duration
 * or `Ttl.Forever`; `uncompactedTurns` a whole number from 0 or `TurnLimit.All`; `turnsBetweenCompactions`,
 * `summaryQueueLength` and `summaryMaxTokens` whole numbers from 1 (`summaryMaxTokens` may be
 * `TokenLimit.ModelMax`); a summarising model is a chat model; a class has `compaction` or a `compact`
 * method, never both. The decorator's overloads say most of it; these hold for a class the compiler did not check.
 */

const SUFFIX = "-memory";

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isTtl = (value: unknown): boolean =>
  value === Ttl.Forever || (typeof value === "number" && Number.isFinite(value) && value > 0);

/** A broken setting of `meta`: `field value — what it must be`. */
const badSetting =
  (cls: Class, meta: MemoryMeta) =>
  (field: string, value: unknown, what: string): RuleViolation =>
    violation("memory.invalid-setting", `${meta.name}: ${field} ${String(value)} — ${what}`, [
      cls.name,
    ]);

/** The settings every memory has: `ttl`, the window and the count between compactions. */
function commonViolations(cls: Class, meta: MemoryMeta): RuleViolation[] {
  const bad = badSetting(cls, meta);
  const found: RuleViolation[] = [];
  if (!isTtl(meta.ttl)) found.push(bad("ttl", meta.ttl, "a duration above 0, or Ttl.Forever"));
  if (meta.uncompactedTurns !== undefined && !isUncompactedTurns(meta.uncompactedTurns))
    found.push(
      violation(
        "memory.uncompacted-turns-invalid",
        `${meta.name}: uncompactedTurns ${JSON.stringify(meta.uncompactedTurns)} — a whole number from 0, or TurnLimit.All`,
        [cls.name],
      ),
    );
  if (meta.turnsBetweenCompactions !== undefined && !isCount(meta.turnsBetweenCompactions))
    found.push(
      bad("turnsBetweenCompactions", meta.turnsBetweenCompactions, "a whole number from 1"),
    );
  return found;
}

/** The settings of a declarative compaction: its limits and a chat model. */
function compactionViolations(cls: Class, meta: MemoryMeta, compaction: MemoryCompaction) {
  const bad = badSetting(cls, meta);
  const found: RuleViolation[] = [];
  if (hasCompactMethod(cls))
    found.push(
      violation(
        "memory.conflicting-compaction",
        `${meta.name}: ${cls.name} sets compaction in its decorator and defines compact(input) — choose one`,
        [cls.name],
      ),
    );
  const { summaryMaxTokens: max, summaryQueueLength: length } = compaction;
  if (max !== undefined && max !== TokenLimit.ModelMax && !isCount(max))
    found.push(bad("summaryMaxTokens", max, "a whole number from 1, or TokenLimit.ModelMax"));
  if (length !== undefined && !isCount(length))
    found.push(bad("summaryQueueLength", length, "a whole number from 1"));
  return found;
}

function settingViolations(cls: Class, meta: MemoryMeta): RuleViolation[] {
  return [
    ...commonViolations(cls, meta),
    ...(meta.compaction === undefined ? [] : compactionViolations(cls, meta, meta.compaction)),
  ];
}

/** Every rule the memory classes break, all at once. */
export function memoryViolations(classes: readonly Class[]): RuleViolation[] {
  return classes.flatMap((cls) => {
    const meta = memoryMetaOf(cls);
    if (meta === undefined) return [];
    const name = meta.name.endsWith(SUFFIX)
      ? []
      : [
          violation("name.kind-suffix", `${meta.name}: a memory's name ends with ${SUFFIX}`, [
            cls.name,
          ]),
        ];
    return [...name, ...settingViolations(cls, meta)];
  });
}
