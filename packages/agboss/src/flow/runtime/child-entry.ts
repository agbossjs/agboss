import type { ChildStart, ChildStartField } from "../analyse/child-workflow.js";
import { StartChoice, type ChildChoice } from "../analyse/children.js";
import { EdgeKind } from "../analyse/flow-graph.js";
import type { RuntimeGraph, RuntimeNode } from "./graph-model.js";
import type { ScopeRecords, ScopeValueRecord, VariantElement } from "./records.js";

/**
 * How a parent enters a child at run time (#263): the start the analyser chose for the edge taken
 * (one start; per item, the start with a field of the item's type; a single launch, the start with a
 * field of the chain's value), and that start's input built from the parent's path scope — the item
 * filling its field in a per-item run (the branch's view holds it as the latest value of its class),
 * every other field from the scope. Nothing else of the parent's scope enters the child.
 */

/** Where a child is entered from: the parent's node of the child, how, and the scope it reads. */
export interface ChildEntrySite {
  readonly graph: RuntimeGraph;
  readonly node: RuntimeNode;
  /** A per-item run of a launch (`.toParallelWorkflows`): the launching node. */
  readonly launcher?: string;
  /** The node visited before (a single child): the edge's other end. */
  readonly previous?: string;
  readonly scope: ScopeRecords;
}

/** The start a child is entered through and its input, with the parent's values it read. */
export interface ChildEntry {
  readonly start: ChildStart;
  readonly input: unknown;
  /** The `valueId`s of the parent's values the input was built from. */
  readonly read: readonly string[];
}

/** `critic-agent#2` → `critic-agent`. */
const nodeOfId = (nodeId: string): string => nodeId.replace(/#\d+$/, "");

/** The value a start's field takes from one record (a `listOf(oneOf(…))` element's value). */
function fieldValueOf(record: ScopeValueRecord): unknown {
  if (!Array.isArray(record.value) || !record.slot.startsWith("list:oneOf(")) return record.value;
  return (record.value as readonly VariantElement[]).map((element) => element.value);
}

/** Every required field of the start is on the scope. */
const isFilled = (start: ChildStart, scope: ScopeRecords): boolean =>
  start.fields.every((field) => !field.isRequired || scope[field.slot] !== undefined);

/** The choices the analyser made for the edges into this child that the visit can have taken. */
function choicesFor(site: ChildEntrySite): readonly ChildChoice[] {
  const into = site.graph.analysis.children.filter(
    (found) => found.entry.edge.to === site.node.id && found.choice === StartChoice.Chosen,
  );
  const isLaunch = (found: ChildChoice): boolean => found.entry.edge.kind === EdgeKind.Launch;
  if (site.launcher !== undefined)
    return into.filter((found) => isLaunch(found) && found.entry.edge.from === site.launcher);
  const single = into.filter((found) => !isLaunch(found));
  const previous = site.previous === undefined ? undefined : nodeOfId(site.previous);
  const near = single.filter((found) => found.entry.edge.from === previous);
  return near.length > 0 ? near : single;
}

/** The start of the edge taken: of several candidate edges, the first whose start the scope fills. */
export function childStartOf(site: ChildEntrySite): ChildStart {
  const starts = choicesFor(site).flatMap((found) => found.starts);
  const chosen = starts.find((start) => isFilled(start, site.scope)) ?? starts[0];
  if (chosen === undefined)
    throw new TypeError(`${site.node.id}: no start was chosen for the edge into it at assembly`);
  return chosen;
}

/** A start's input from the scope: its one DTO or list, or a map of its fields. */
export function childEntryOf(site: ChildEntrySite): ChildEntry {
  const start = childStartOf(site);
  const read: string[] = [];
  const valueOf = (field: ChildStartField): unknown => {
    const record = site.scope[field.slot];
    if (record === undefined) return undefined;
    read.push(record.valueId);
    return fieldValueOf(record);
  };
  const [whole] = start.fields;
  const input =
    whole !== undefined && start.fields.length === 1 && whole.name === start.name
      ? valueOf(whole)
      : Object.fromEntries(
          start.fields.flatMap((field) => {
            const value = valueOf(field);
            return value === undefined ? [] : [[field.name, value] as const];
          }),
        );
  return { start, input, read: [...new Set(read)].sort() };
}
