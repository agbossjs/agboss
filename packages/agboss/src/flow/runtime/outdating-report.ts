import type { RunnableConfig } from "@langchain/core/runnables";
import { RunnableLambda } from "@langchain/core/runnables";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import type { StepDescriptor } from "../context/execution-context.js";
import type { ExecutionFacts } from "../context/frame.js";
import type { ValuesOutdatedEvent } from "../observers/values-outdated.js";
import { nodeEventOf } from "../observers/execution-event.js";
import type { OutdatingCascade } from "./outdating.js";
import {
  OutdatedReason,
  type OutdatedValueRecord,
  type ScopeValueRecord,
  type ScopeValueReference,
} from "./records.js";

/**
 * What a cascade tells the world (#271 rule 11, S12): one observer event (`onValuesOutdated`) and one
 * trace entry ("values outdated", a child run of the step, so Langfuse shows it under the node) with
 * the same content plus a sentence per value — `DraftChangesDto#1 outdated: about DraftDto#1,
 * replaced by DraftDto#2 from writer-agent`. Neither carries a DTO value. The labels `DraftDto#2`
 * are ordinals within a slot, counted over the execution.
 */

/** The trace entry of a cascade. */
export interface ValuesOutdatedTrace {
  readonly trigger: ScopeValueReference;
  readonly outdated: ValuesOutdatedEvent["outdated"];
  /** One sentence per outdated value, in the order of `outdated`. */
  readonly reasons: readonly string[];
}

/** Where a visit's cascades are reported, and what labels them. */
export interface OutdatingReportSite {
  readonly observer?: ExecutionObserverManager;
  readonly config?: RunnableConfig;
  readonly execution: ExecutionFacts;
  readonly step: StepDescriptor;
  /** Every value outdated in the execution so far, this visit's included (for the ordinals). */
  readonly outdatedSoFar: readonly OutdatedValueRecord[];
}

const reference = (record: ScopeValueRecord): ScopeValueReference => ({
  valueId: record.valueId,
  slot: record.slot,
  producer: record.producer,
});

/** `DraftDto`, `listOf(CritiqueDto)`, `DraftDto[before]`. */
function slotName(slot: string): string {
  const [base = slot, tag] = slot.split("#");
  const shape = base.startsWith("list:") ? `listOf(${base.slice("list:".length)})` : base;
  return tag === undefined ? shape : `${shape}[${tag}]`;
}

/** `DraftDto#2`: the value's ordinal within its slot; a new value comes after every outdated one. */
function labelOf(record: ScopeValueRecord, outdatedSoFar: readonly OutdatedValueRecord[]): string {
  const older = outdatedSoFar.filter((value) => value.slot === record.slot);
  const index = older.findIndex((value) => value.valueId === record.valueId);
  return `${slotName(record.slot)}#${String(index === -1 ? older.length + 1 : index + 1)}`;
}

/** The sentence of one outdated value. */
function reasonText(
  record: OutdatedValueRecord,
  cascade: OutdatingCascade,
  outdatedSoFar: readonly OutdatedValueRecord[],
): string {
  const label = (value: ScopeValueRecord): string => labelOf(value, outdatedSoFar);
  const by = `replaced by ${label(cascade.trigger)} from ${cascade.trigger.producer}`;
  if (record.outdated.reason === OutdatedReason.Replaced) return `${label(record)} outdated: ${by}`;
  const cause = cascade.outdated.find((value) => record.builtFrom.includes(value.valueId));
  const how = record.outdated.reason === OutdatedReason.AboutReplaced ? "about" : "built from";
  const through = cause === undefined ? "" : `${how} ${label(cause)}, `;
  return `${label(record)} outdated: ${through}${by}`;
}

/** The trace entry of one cascade. */
export function traceOf(
  cascade: OutdatingCascade,
  outdatedSoFar: readonly OutdatedValueRecord[],
): ValuesOutdatedTrace {
  return {
    trigger: reference(cascade.trigger),
    outdated: cascade.outdated.map((record) => ({
      ...reference(record),
      reason: record.outdated.reason,
    })),
    reasons: cascade.outdated.map((record) => reasonText(record, cascade, outdatedSoFar)),
  };
}

/** The event of one cascade. */
const eventOf = (site: OutdatingReportSite, trace: ValuesOutdatedTrace): ValuesOutdatedEvent => ({
  ...nodeEventOf(site),
  trigger: trace.trigger,
  outdated: trace.outdated,
});

const traceEntry = RunnableLambda.from((trace: ValuesOutdatedTrace) => trace);

/** Reports every cascade of a visit: the trace entry, then the observers. */
export async function reportOutdating(
  cascades: readonly OutdatingCascade[],
  site: OutdatingReportSite,
): Promise<void> {
  for (const cascade of cascades) {
    const trace = traceOf(cascade, site.outdatedSoFar);
    const parent = site.config ?? {};
    await traceEntry.invoke(trace, {
      callbacks: parent.callbacks,
      tags: parent.tags,
      metadata: parent.metadata,
      runName: "values outdated",
    });
    await site.observer?.onValuesOutdated(eventOf(site, trace));
  }
}
