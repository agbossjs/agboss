import type { ResolvedField } from "../analyse/fields.js";
import { prettyJson } from "./json.js";
import type { ScopeValueRecord, VariantElement } from "./records.js";
import { elementProducerOf, previousOf, type ScopeView } from "./scope.js";

/**
 * The input message (#270 Q51): built by the framework, always the same way — every `input` field
 * in declaration order, each as `### <field> (from <producer>)` and its value as formatted JSON with
 * sorted keys; an absent `optional` field is `none`; a list is a JSON array of `{ producer, value }`;
 * a `historyOf` field is its current value, then `### <field>, earlier versions (oldest first)` as a
 * JSON array of `{ producer, value }` (`[]` on the first visit, #299 S56). Outside data stay in the
 * `user` role; instructions never hold them.
 */

const listItems = (record: ScopeValueRecord): readonly unknown[] => {
  const values = Array.isArray(record.value) ? (record.value as readonly unknown[]) : [];
  const isOneOf = record.slot.startsWith("list:oneOf(");
  return values.map((element, index) =>
    isOneOf
      ? {
          producer: elementProducerOf(record, index),
          variant: (element as VariantElement).variant,
          value: (element as VariantElement).value,
        }
      : { producer: elementProducerOf(record, index), value: element },
  );
};

function valueText(field: ResolvedField, record: ScopeValueRecord): string {
  const variant = record.variant === undefined ? "" : `, ${record.variant}`;
  return `### ${field.name} (from ${record.producer}${variant})\n${prettyJson(record.value)}`;
}

/** A `historyOf` field's earlier versions, oldest first. */
function previousText(field: ResolvedField, view: ScopeView): string {
  const versions = previousOf(field, view.outdatedValues).map((version) =>
    version.variant === undefined
      ? { producer: version.producer, value: version.value }
      : { producer: version.producer, variant: version.variant, value: version.value },
  );
  return `### ${field.name}, earlier versions (oldest first)\n${prettyJson(versions)}`;
}

function fieldText(field: ResolvedField, view: ScopeView): string {
  const record = view.scope[field.slot];
  if (record === undefined) return `### ${field.name}\nnone`;
  if (field.isList) return `### ${field.name}\n${prettyJson(listItems(record))}`;
  if (field.history !== undefined)
    return `${valueText(field, record)}\n\n${previousText(field, view)}`;
  return valueText(field, record);
}

/** The input message of a node's fields over the current scope (and, for `historyOf`, the outdated values). */
export function inputMessageOf(fields: readonly ResolvedField[], view: ScopeView): string {
  return fields
    .filter((field) => !field.isPassThrough)
    .map((field) => fieldText(field, view))
    .join("\n\n");
}
