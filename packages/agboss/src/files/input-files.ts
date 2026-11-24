import { fileFieldsOf } from "../a2a/files/a2a-file.dto.js";
import { isFileDescriptor } from "../a2a/files/a2a-file-scrub.js";
import { A2AFileDto } from "../a2a/files/a2a-file.dto.js";
import type { DtoClass } from "../dto/types.js";
import type { ResolvedField } from "../flow/analyse/fields.js";
import { elementProducerOf } from "../flow/runtime/scope.js";
import type { ScopeRecords } from "../flow/runtime/records.js";
import { dtoOfShape } from "../pii/field-masks.js";
import type { SourceFile } from "./visit-files.js";

/**
 * The files an agent's input holds (#899 §3): a field whose shape is the file DTO itself, a list of
 * them, or a DTO with `A2AFileDto` fields — each a source file shown under the field it sits in.
 */

const isFileDto = (dto: DtoClass): boolean =>
  dto === A2AFileDto || dto.prototype instanceof A2AFileDto;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

/** An element of a `listOf(oneOf(…))` value; its `variant` is only compared with the DTO names. */
const isVariantElement = (
  element: unknown,
): element is { readonly variant: unknown; readonly value: unknown } =>
  typeof element === "object" && element !== null && "variant" in element && "value" in element;

/** The descriptors of one value of `dto`, each with the name it is shown under. */
export function filesOfValue(
  dto: DtoClass,
  value: unknown,
  field: string,
): readonly { readonly descriptor: A2AFileDto; readonly field: string }[] {
  if (isFileDto(dto)) return isFileDescriptor(value) ? [{ descriptor: value, field }] : [];
  const record = asRecord(value);
  return fileFieldsOf(dto).flatMap((fileField) => {
    const held = record[fileField.name];
    const items: unknown[] = Array.isArray(held) ? held : [held];
    return items.flatMap((item) =>
      isFileDescriptor(item) ? [{ descriptor: item, field: `${field}.${fileField.name}` }] : [],
    );
  });
}

/** The files of one value (of an element of a list), each produced by `producer`; none for a variant that names no DTO. */
function filesOfField(
  field: ResolvedField,
  variant: unknown,
  value: unknown,
  producer: SourceFile["producer"],
): readonly SourceFile[] {
  const dto = dtoOfShape(field.shape, variant);
  return dto === undefined
    ? []
    : filesOfValue(dto, value, field.name).map((found) => ({ ...found, producer }));
}

/** The source files of a node's input fields, in declaration order. */
export function inputFilesOf(
  fields: readonly ResolvedField[],
  scope: ScopeRecords,
): readonly SourceFile[] {
  return fields.flatMap((field) => {
    const record = scope[field.slot];
    if (field.isPassThrough || record === undefined) return [];
    if (!field.isList) return filesOfField(field, record.variant, record.value, record.producer);
    const isOneOf = record.slot.startsWith("list:oneOf(");
    // a list slot holds an array (records.ts)
    return (record.value as readonly unknown[]).flatMap((element, index) => {
      const { variant, value } =
        isOneOf && isVariantElement(element) ? element : { variant: undefined, value: element };
      return filesOfField(field, variant, value, elementProducerOf(record, index));
    });
  });
}
