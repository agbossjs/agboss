import { fileFieldsOf } from "../a2a/files/a2a-file.dto.js";
import { isFileDescriptor } from "../a2a/files/a2a-file-scrub.js";
import { A2AFileDto } from "../a2a/files/a2a-file.dto.js";
import type { DtoClass } from "../dto/types.js";
import type { ResolvedField } from "../flow/analyse/fields.js";
import { elementProducerOf } from "../flow/runtime/scope.js";
import type { ScopeRecords, VariantElement } from "../flow/runtime/records.js";
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

const isVariantElement = (element: unknown): element is VariantElement =>
  typeof element === "object" &&
  element !== null &&
  typeof Reflect.get(element, "variant") === "string" &&
  "value" in element;

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

/** The source files of a node's input fields, in declaration order. */
export function inputFilesOf(
  fields: readonly ResolvedField[],
  scope: ScopeRecords,
): readonly SourceFile[] {
  return fields.flatMap((field) => {
    const record = scope[field.slot];
    if (field.isPassThrough || record === undefined) return [];
    if (field.isList) {
      const items: readonly unknown[] = Array.isArray(record.value) ? record.value : [];
      const isOneOf = record.slot.startsWith("list:oneOf(");
      return items.flatMap((element, index) => {
        const { variant, value } =
          isOneOf && isVariantElement(element) ? element : { variant: undefined, value: element };
        const dto = dtoOfShape(field.shape, variant);
        const producer = elementProducerOf(record, index);
        return dto === undefined
          ? []
          : filesOfValue(dto, value, field.name).map((found) => ({ ...found, producer }));
      });
    }
    const dto = dtoOfShape(field.shape, record.variant);
    return dto === undefined
      ? []
      : filesOfValue(dto, record.value, field.name).map((found) => ({
          ...found,
          producer: record.producer,
        }));
  });
}
