import type { ResolvedField } from "../analyse/fields.js";
import type { ValueWrite } from "../analyse/flow-graph.js";
import { slotOfField, slotOfWrite } from "../analyse/scope.js";
import { NodeKind } from "../ast.js";
import { isFieldMap } from "../decorators/declaration.js";
import { Wrapper, withVariant, type HistoryOf, type ProducedValue } from "../dto-wrappers.js";
import type { RuntimeGraph, RuntimeNode } from "./graph-model.js";
import { writtenProvenanceOf } from "./provenance.js";
import {
  valueIdOf,
  type OutdatedValueRecord,
  type ScopeRecords,
  type ScopeValueRecord,
  type VariantElement,
} from "./records.js";

/**
 * The path scope at run time (#270 → path scope, #271 S11): a node's outgoing edge writes each value
 * into its one slot (a write replaces the slot's value), and a node reads its `input` fields from
 * their slots, each rebuilt into `{ producer, value }` with the producer's class. A
 * `historyOf(XDto)` field also reads the earlier versions of its slot from `outdatedValues` (#299
 * S56).
 */

/** What a node reads: the current values, and the outdated ones (for `historyOf`). */
export interface ScopeView {
  readonly scope: ScopeRecords;
  readonly outdatedValues: readonly OutdatedValueRecord[];
}

/** What a visit of a node gave: its value and, for a `oneOf`, the class it is. */
export interface NodeValue {
  readonly value: unknown;
  readonly variant?: string;
}

/** Where a visit writes: which node, which visit, what it read, and the scope it writes into. */
export interface WriteSite {
  readonly node: RuntimeNode;
  readonly visitNumber: number;
  readonly builtFrom: readonly string[];
  /** The scope before the write: a write's `{ about }` targets are read from it (#271 S40 b). */
  readonly scope: ScopeRecords;
}

/** A map start's field values by their slot, so `.returns(A, optional(B))` finds each. */
function startFieldValue(node: RuntimeNode, write: ValueWrite, given: NodeValue): unknown {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Start) return given.value;
  const { input } = declaration.options;
  if (!isFieldMap(input)) return given.value;
  const slot = slotOfWrite(write);
  const field = Object.entries(input).find(([, shape]) => slotOfField(shape).slot === slot);
  const values = given.value as Readonly<Record<string, unknown>>;
  return field === undefined ? undefined : values[field[0]];
}

/** The record one write puts into the scope; none for an absent `optional` value. */
function writeRecord(
  site: WriteSite,
  write: ValueWrite,
  writes: readonly ValueWrite[],
  given: NodeValue,
): ScopeValueRecord | undefined {
  const value = startFieldValue(site.node, write, given);
  const isOptional = typeof write.shape !== "function" && write.shape.kind === Wrapper.Optional;
  if (isOptional && value === undefined) return undefined;
  const slot = slotOfWrite(write);
  const { builtFrom, about } = writtenProvenanceOf(site.builtFrom, write, site.scope, writes);
  const variant = typeof write.shape === "function" ? given.variant : undefined;
  return {
    valueId: valueIdOf(site.node.id, site.visitNumber, slot),
    slot,
    producer: site.node.id,
    ...(variant === undefined ? {} : { variant }),
    value,
    builtFrom,
    ...(about.length === 0 ? {} : { about }),
  };
}

/** What an edge writes for a visit, by slot. */
export function recordsOfWrites(
  site: WriteSite,
  writes: readonly ValueWrite[],
  given: NodeValue,
): ScopeRecords {
  const records = writes.flatMap((write) => writeRecord(site, write, writes, given) ?? []);
  return Object.fromEntries(records.map((record) => [record.slot, record]));
}

/** A node's input as its handler or its model reads it: `Produced` fields, and what was read. */
export interface ReadInput {
  readonly fields: Readonly<Record<string, unknown>>;
  /** The `valueId`s read (the `builtFrom` of what the node writes). */
  readonly read: readonly string[];
}

/** Rebuilds one value of a slot into `{ producer, value }` (with its class for a `oneOf`). */
function produced(graph: RuntimeGraph, producer: string, value: unknown, variant?: string) {
  const item: ProducedValue<unknown, unknown> = {
    producer: graph.nodes.get(producer)?.component,
    value,
  };
  const dto = variant === undefined ? undefined : graph.dtos.get(variant);
  return dto === undefined ? item : withVariant(item, dto);
}

/** The earlier versions of a `historyOf` field's slot, oldest first, at most its `limit`. */
export function previousOf(
  field: ResolvedField,
  outdatedValues: readonly OutdatedValueRecord[],
): readonly OutdatedValueRecord[] {
  const limit = field.history?.limit;
  const versions = outdatedValues.filter((record) => record.slot === field.slot);
  return limit === undefined ? versions : versions.slice(-limit);
}

function fieldValue(
  graph: RuntimeGraph,
  field: ResolvedField,
  record: ScopeValueRecord,
  outdatedValues: readonly OutdatedValueRecord[],
): unknown {
  if (field.history !== undefined) {
    const history: HistoryOf<unknown> = {
      current: produced(graph, record.producer, record.value, record.variant),
      previous: previousOf(field, outdatedValues).map((version) =>
        produced(graph, version.producer, version.value, version.variant),
      ),
    };
    return history;
  }
  if (!field.isList || !Array.isArray(record.value)) {
    return produced(graph, record.producer, record.value, record.variant);
  }
  const isOneOf = record.slot.startsWith("list:oneOf(");
  return (record.value as readonly unknown[]).map((element, index) => {
    const producer = elementProducerOf(record, index);
    return isOneOf
      ? produced(
          graph,
          producer,
          (element as VariantElement).value,
          (element as VariantElement).variant,
        )
      : produced(graph, producer, element);
  });
}

/** Who gave one element of a list: its own producer when a join gathered several (#273). */
export const elementProducerOf = (record: ScopeValueRecord, index: number): string =>
  record.elementProducers?.[index] ?? record.producer;

/** Reads a node's fields from the scope; an absent `optional` field is `undefined`. */
export function readInput(
  graph: RuntimeGraph,
  node: Pick<RuntimeNode, "fields">,
  view: ScopeView,
): ReadInput {
  const fields: Record<string, unknown> = {};
  const read: string[] = [];
  for (const field of node.fields) {
    const record = view.scope[field.slot];
    if (record === undefined) continue;
    fields[field.name] = fieldValue(graph, field, record, view.outdatedValues);
    read.push(record.valueId);
  }
  return { fields, read: [...new Set(read)].sort() };
}

/** Whether an output shape is a list (its value is an array). */
export const isListOutput = (shape: unknown): boolean =>
  typeof shape === "object" && shape !== null && "kind" in shape && shape.kind === Wrapper.List;
