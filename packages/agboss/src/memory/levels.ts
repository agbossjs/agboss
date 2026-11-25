import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { TurnLimit } from "../config/types.js";
import { memoryMetaOf, type UncompactedTurns } from "./memory.decorator.js";

/**
 * The memory of each reader of the thread (#1303) — every agent and model router. A reader's own
 * `memory` wins over its workflow's; a memory summarises what is older than the smallest window
 * among the readers that use it (`windowOfCompaction`, `plan.ts`), so none of them loses a turn.
 */

/** One reader's own setting: an agent's or a model router's. */
export interface MemoryReaderElement {
  readonly name: string;
  readonly memory?: Class;
}

/** The settings of one workflow, by level. */
export interface MemoryLevels {
  readonly workflow: { readonly name: string; readonly memory?: Class };
  readonly elements: readonly MemoryReaderElement[];
}

/** What the levels give: each reader's memory, every one in use, the rules broken. */
export interface EffectiveMemories {
  /** By reader: the class in effect, `undefined` = none. */
  readonly byElement: ReadonlyMap<string, Class | undefined>;
  /** The classes some reader uses, in first-use order. */
  readonly classes: readonly Class[];
  readonly violations: readonly RuleViolation[];
}

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** Whether a window is a whole number from 0 or `TurnLimit.All`. */
export const isUncompactedTurns = (value: unknown): value is UncompactedTurns =>
  value === TurnLimit.All || (typeof value === "number" && Number.isInteger(value) && value >= 0);

function notAMemory(cls: Class | undefined, where: string): RuleViolation[] {
  if (cls === undefined || memoryMetaOf(cls) !== undefined) return [];
  return [
    violation(
      "memory.not-a-memory",
      `${where}: memory is ${nameOf(cls)}, which is not a @Memory class`,
      [nameOf(cls)],
    ),
  ];
}

/** Each reader's memory (own, else the workflow's) and the rules broken. */
export function effectiveMemories(levels: MemoryLevels): EffectiveMemories {
  const { workflow } = levels;
  const violations: RuleViolation[] = notAMemory(workflow.memory, workflow.name);
  const byElement = new Map<string, Class | undefined>();
  for (const element of levels.elements) {
    violations.push(...notAMemory(element.memory, element.name));
    byElement.set(element.name, element.memory ?? workflow.memory);
  }
  const used = [...byElement.values()].filter((cls): cls is Class => cls !== undefined);
  const classes = [...new Set(used)].filter((cls) => memoryMetaOf(cls) !== undefined);
  return { byElement, classes, violations };
}
