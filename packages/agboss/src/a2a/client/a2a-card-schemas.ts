import type { DtoClass } from "../../dto/types.js";
import { jsonSchemaOf, type JsonSchema } from "../../dto/schema.js";
import { incompatibilitiesOf } from "../../federation/schema-compat.js";
import { withoutFileFields } from "../a2a-card-file-fields.js";
import { fileFieldsOf } from "../files/a2a-file.dto.js";
import {
  declaredFileFieldsOf,
  declaredOutputFileFieldsOf,
  fileFieldDifferencesOf,
  outputFileFieldDifferencesOf,
  type DeclaredFileFields,
} from "./a2a-card-files.js";

/**
 * An AGBoss peer's skill schemas (#809), read from its skills extension entry, and how the client's
 * DTOs differ from them (`[a2a.schema-mismatch]`): the input, and every finish's output — each data
 * schema compared without its file fields, each side's (#904, #916), the file fields apart.
 */

/** What the client declares of a skill's data. */
export interface SchemaExpectation {
  readonly input: DtoClass | undefined;
  readonly output: DtoClass | undefined;
  /** The skill's finishes the output takes (#916); unset: every one. */
  readonly finishes?: readonly string[] | undefined;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON Schemas an AGBoss peer declares for one skill. */
export interface SkillSchemas {
  readonly input: JsonSchema | undefined;
  readonly outputs: Readonly<Record<string, FinishSchema>>;
  /** Its file fields (#904): in the extension's `files`, or marked in `input`. */
  readonly files: DeclaredFileFields;
}

/** One finish's output on the card: its data schema and its file fields (#916 item 4). */
interface FinishSchema {
  readonly schema: JsonSchema;
  readonly files: DeclaredFileFields;
}

/** The schemas a skill's entry of the skills extension declares. */
export function skillSchemasOf(entry: Readonly<Record<string, unknown>>): SkillSchemas {
  const outputs = isRecord(entry.outputs) ? entry.outputs : {};
  return {
    input: isRecord(entry.input) ? entry.input : undefined,
    files: declaredFileFieldsOf(entry),
    outputs: Object.fromEntries(
      Object.entries(outputs).flatMap(([finish, schema]) =>
        isRecord(schema)
          ? [[finish, { schema, files: declaredOutputFileFieldsOf(entry, finish) }]]
          : [],
      ),
    ),
  };
}

/** The differences between a skill's schemas and the client's DTOs (`input: …`, `output (f): …`). */
export function schemaDifferencesOf(
  schemas: SkillSchemas,
  expected: SchemaExpectation,
): readonly string[] {
  const found: string[] = [];
  if (expected.input !== undefined && schemas.input !== undefined) {
    // #904: the data part compared without the file fields, each side's; the file fields apart
    const own = new Set(fileFieldsOf(expected.input).map((field) => field.name));
    const sent = withoutFileFields(jsonSchemaOf(expected.input), own);
    const accepted = withoutFileFields(schemas.input, new Set(schemas.files.keys()));
    found.push(...incompatibilitiesOf(accepted, sent).map((reason) => `input: ${reason}`));
    found.push(...fileFieldDifferencesOf(expected.input, schemas.files));
  }
  if (expected.output !== undefined)
    found.push(...outputDifferencesOf(schemas, expected.output, expected.finishes));
  return found;
}

/** The finishes a client names (#916) that the skill's card does not list (`[a2a.unknown-finish]`). */
export function unknownFinishesOf(
  schemas: SkillSchemas,
  finishes: readonly string[] | undefined,
): readonly string[] {
  const listed = Object.keys(schemas.outputs);
  return (finishes ?? [])
    .filter((finish) => !Object.hasOwn(schemas.outputs, finish))
    .map((finish) => `${finish} is not a finish of the skill (its finishes: ${listed.join(", ")})`);
}

/**
 * #916: each finish the client takes — those it names, else every one — its data compared without
 * the file fields, each side's (item 4); the files apart.
 */
function outputDifferencesOf(
  schemas: SkillSchemas,
  output: DtoClass,
  finishes: readonly string[] | undefined,
): readonly string[] {
  const own = new Set(fileFieldsOf(output).map((field) => field.name));
  const accepted = withoutFileFields(jsonSchemaOf(output), own);
  const taken = Object.entries(schemas.outputs).filter(
    ([finish]) => finishes === undefined || finishes.includes(finish),
  );
  return taken.flatMap(([finish, given]) => [
    ...incompatibilitiesOf(
      accepted,
      withoutFileFields(given.schema, new Set(given.files.keys())),
    ).map((reason) => `output (${finish}): ${reason}`),
    ...outputFileFieldDifferencesOf(output, given.files, finish),
  ]);
}
