import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { compactionMetaOf, TurnLimit, type UncompactedTurns } from "./compaction.decorator.js";

/**
 * The compaction and the window of each reader of the thread (#120 PR 3) — every agent and model
 * router. Both are single settings on `@Application` → `@Workflow` → `@Agent` / `@Router`: the
 * lowest level that sets one wins. A compaction summarises what is older than the smallest window
 * among the readers that use it (`windowOfCompaction`, `plan.ts`), so none of them loses a turn.
 * Loaded with the assembly of compactions, on first use (`workflowOf`).
 */

/** One reader's own settings: an agent's or a model router's. */
export interface MemoryReaderElement {
  readonly name: string;
  readonly compaction?: Class;
  readonly uncompactedTurns?: UncompactedTurns;
}

/** The settings of one workflow, by level. */
export interface CompactionLevels {
  readonly application?: { readonly compaction?: Class; readonly uncompactedTurns?: unknown };
  readonly workflow: {
    readonly name: string;
    readonly compaction?: Class;
    readonly uncompactedTurns?: unknown;
  };
  readonly elements: readonly MemoryReaderElement[];
}

/** What the levels give: each reader's compaction, every one in use, the rules broken. */
export interface EffectiveCompactions {
  /** By reader: the class in effect, `undefined` = none (the window only). */
  readonly byElement: ReadonlyMap<string, Class | undefined>;
  /** The classes some reader uses, in first-use order. */
  readonly classes: readonly Class[];
  readonly violations: readonly RuleViolation[];
}

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** Whether a window is a whole number from 0 or `TurnLimit.ALL`. */
export const isUncompactedTurns = (value: unknown): value is UncompactedTurns =>
  value === TurnLimit.ALL || (typeof value === "number" && Number.isInteger(value) && value >= 0);

function notACompaction(cls: Class | undefined, where: string): RuleViolation[] {
  if (cls === undefined || compactionMetaOf(cls) !== undefined) return [];
  return [
    violation(
      "compaction.not-a-compaction",
      `${where}: compaction is ${nameOf(cls)}, which is not a @Compaction class`,
      [nameOf(cls)],
    ),
  ];
}

function invalidWindow(value: unknown, where: string): RuleViolation[] {
  if (value === undefined || isUncompactedTurns(value)) return [];
  return [
    violation(
      "compaction.uncompacted-turns-invalid",
      `${where}: uncompactedTurns ${JSON.stringify(value)} — a whole number from 0, or TurnLimit.ALL`,
      [where],
    ),
  ];
}

/** Each reader's compaction (own, else the workflow's, else the application's) and the rules broken. */
export function effectiveCompactions(levels: CompactionLevels): EffectiveCompactions {
  const { application, workflow } = levels;
  const violations: RuleViolation[] = [
    ...notACompaction(application?.compaction, "the application"),
    ...invalidWindow(application?.uncompactedTurns, "the application"),
    ...notACompaction(workflow.compaction, workflow.name),
    ...invalidWindow(workflow.uncompactedTurns, workflow.name),
  ];
  const inherited = workflow.compaction ?? application?.compaction;
  const byElement = new Map<string, Class | undefined>();
  for (const element of levels.elements) {
    violations.push(...notACompaction(element.compaction, element.name));
    violations.push(...invalidWindow(element.uncompactedTurns, element.name));
    byElement.set(element.name, element.compaction ?? inherited);
  }
  const used = [...byElement.values()].filter((cls): cls is Class => cls !== undefined);
  const classes = [...new Set(used)].filter((cls) => compactionMetaOf(cls) !== undefined);
  return { byElement, classes, violations };
}
