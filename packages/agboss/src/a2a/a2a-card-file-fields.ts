import type { JsonSchema } from "../dto/schema.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * How an Agent Card describes a skill's file fields (#904): they are sent as file parts, never in
 * the data part, so the skill's data `input` schema must not ask for them.
 */
export enum A2ACardFileFields {
  /**
   * Out of the data `input` schema (and its `required`), declared in the skills extension as
   * `files: { <field>: { list, optional, mediaTypes } }` — the default.
   */
  Extension = "extension",
  /**
   * In the data `input` schema, each one's schema `{ "x-agboss-file-part": true, description }` and
   * never `required`: a validator that does not know the keyword asks nothing of it in data.
   */
  Marker = "marker",
}

/** The JSON Schema keyword a `Marker` file field's schema carries. */
export const FILE_PART_KEYWORD = "x-agboss-file-part";

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

/** What an `@A2AExpose` says of its card's file fields: for all its skills, or for one. */
export interface CardFileFieldsSource {
  readonly cardFileFields?: A2ACardFileFields;
  readonly skills?: Readonly<Record<string, { readonly cardFileFields?: A2ACardFileFields }>>;
}

/** How the card of `expose` describes the file fields of the skill `start`: its own, the expose's, `Extension`. */
export const cardFileFieldsOf = (expose: CardFileFieldsSource, start: string): A2ACardFileFields =>
  expose.skills?.[start]?.cardFileFields ?? expose.cardFileFields ?? A2ACardFileFields.Extension;

const VALUES = new Set<unknown>(Object.values(A2ACardFileFields));

/**
 * `[a2a.file-options-invalid]`, a value that is none of the enum's (a JS caller, a cast), and
 * `[a2a.unknown-skill-option]`, one set for a skill the expose does not export.
 */
export function cardFileFieldsViolations(
  name: string,
  expose: CardFileFieldsSource,
  exported: ReadonlySet<string>,
  where: string,
): RuleViolation[] {
  const unknown = Object.entries(expose.skills ?? {})
    .filter(([skill, options]) => options.cardFileFields !== undefined && !exported.has(skill))
    .map(([skill]) =>
      violation(
        "a2a.unknown-skill-option",
        `${name} sets the cardFileFields of ${skill}, which it does not export — name an exported start`,
        [where],
      ),
    );
  return [...unknown, ...invalidValues(name, expose, where)];
}

function invalidValues(name: string, expose: CardFileFieldsSource, where: string): RuleViolation[] {
  const given: [string, unknown][] = [
    ["cardFileFields", expose.cardFileFields],
    ...Object.entries(expose.skills ?? {}).map(([skill, options]): [string, unknown] => [
      `skills["${skill}"].cardFileFields`,
      options.cardFileFields,
    ]),
  ];
  return given
    .filter(([, value]) => value !== undefined && !VALUES.has(value))
    .map(([at]) =>
      violation(
        "a2a.file-options-invalid",
        `${name}'s ${at} is not an A2ACardFileFields (Extension or Marker)`,
        [where],
      ),
    );
}
