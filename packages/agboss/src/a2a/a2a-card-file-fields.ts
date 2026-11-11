import type { JsonSchema } from "../dto/schema.js";

/**
 * The JSON Schema keyword a `Marker` file field's schema carries (#904); its value is the field's
 * declaration (#916), as `Extension` declares it in the skills extension.
 */
export const FILE_PART_KEYWORD = "x-agboss-file-part";

/** A file field as a card declares it: one file or a list, optional or not, its media types. */
export interface CardFileField {
  readonly list: boolean;
  readonly optional: boolean;
  readonly mediaTypes: readonly string[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An object's schema that asks nothing of `fields` in data: each one left out — or, with
 * `markerOf`, its schema replaced by its marker — and none of them required.
 */
export function withoutFileFields(
  schema: JsonSchema,
  fields: ReadonlySet<string>,
  markerOf?: (field: string, property: unknown) => JsonSchema,
): JsonSchema {
  if (fields.size === 0) return schema;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const kept = Object.entries(properties).flatMap(([name, property]): [string, unknown][] => {
    if (!fields.has(name)) return [[name, property]];
    return markerOf === undefined ? [] : [[name, markerOf(name, property)]];
  });
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => !fields.has(String(name)))
    : [];
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "required"));
  return {
    ...rest,
    properties: Object.fromEntries(kept),
    ...(required.length === 0 ? {} : { required }),
  };
}
