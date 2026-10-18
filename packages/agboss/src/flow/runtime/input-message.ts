import type { FieldMask } from "../../dto/redact.js";
import { maskedShapeValue } from "../../pii/field-masks.js";
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
 * `user` role; instructions never hold them. With a field mask (the model boundary, #120) every
 * `sensitive` field of a value goes through its action first.
 */

/** A value as the message shows it: its `sensitive` fields masked when there is a mask. */
const shown = (
  field: ResolvedField,
  value: unknown,
  mask: FieldMask | undefined,
  variant?: string,
): unknown => (mask === undefined ? value : maskedShapeValue(field.shape, value, mask, variant));

const listItems = (
  field: ResolvedField,
  record: ScopeValueRecord,
  mask: FieldMask | undefined,
): readonly unknown[] => {
  const values = Array.isArray(record.value) ? (record.value as readonly unknown[]) : [];
  const isOneOf = record.slot.startsWith("list:oneOf(");
  return values.map((element, index) => {
    const producer = elementProducerOf(record, index);
    if (!isOneOf) return { producer, value: shown(field, element, mask) };
    const { variant, value } = element as VariantElement;
    return { producer, variant, value: shown(field, value, mask, variant) };
  });
};

function valueText(
  field: ResolvedField,
  record: ScopeValueRecord,
  mask: FieldMask | undefined,
): string {
  const variant = record.variant === undefined ? "" : `, ${record.variant}`;
  const value = shown(field, record.value, mask, record.variant);
  return `### ${field.name} (from ${record.producer}${variant})\n${prettyJson(value)}`;
}

/** A `historyOf` field's earlier versions, oldest first. */
function previousText(field: ResolvedField, view: ScopeView, mask: FieldMask | undefined): string {
  const versions = previousOf(field, view.outdatedValues).map((version) => {
    const value = shown(field, version.value, mask, version.variant);
    return version.variant === undefined
      ? { producer: version.producer, value }
      : { producer: version.producer, variant: version.variant, value };
  });
  return `### ${field.name}, earlier versions (oldest first)\n${prettyJson(versions)}`;
}

function fieldText(field: ResolvedField, view: ScopeView, mask: FieldMask | undefined): string {
  const record = view.scope[field.slot];
  if (record === undefined) return `### ${field.name}\nnone`;
  if (field.isList) return `### ${field.name}\n${prettyJson(listItems(field, record, mask))}`;
  if (field.history !== undefined)
    return `${valueText(field, record, mask)}\n\n${previousText(field, view, mask)}`;
  return valueText(field, record, mask);
}

/** The input message of a node's fields over the current scope (and, for `historyOf`, the outdated values). */
export function inputMessageOf(
  fields: readonly ResolvedField[],
  view: ScopeView,
  mask?: FieldMask,
): string {
  return fields
    .filter((field) => !field.isPassThrough)
    .map((field) => fieldText(field, view, mask))
    .join("\n\n");
}
