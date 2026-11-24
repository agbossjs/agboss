import type { JsonSchema } from "../../dto/schema.js";
import {
  FILE_PART_KEYWORD,
  withoutFileFields,
  type CardFileField,
} from "../a2a-card-file-fields.js";
import type { A2AFileField } from "../files/a2a-file.dto.js";
import { A2ACardFileFields } from "../files/a2a-file-options.js";
import type { ServedSkill } from "./a2a-skills.js";

/**
 * A skill's input and its finishes' outputs as its Agent Card describes them (#904, #916 item 4):
 * their file fields travel as file parts, never in a data part — so no data schema asks for them.
 * `Extension` leaves them out of it and declares them in the skills extension (`files` for the
 * input, `outputFiles` by finish); `Marker` keeps each one in it as `{ "x-agboss-file-part": { list,
 * optional, mediaTypes }, description }` (#916 item 2: what `Extension` declares), out of `required`.
 */

/** The skills extension's entry of one skill's input: its data schema, and its files when declared there. */
export interface CardSkillInput {
  readonly input: JsonSchema | null;
  readonly cardFileFields: A2ACardFileFields;
  readonly files?: Readonly<Record<string, CardFileField>>;
}

/** The skills extension's entry of one skill's finishes: each one's data schema, and its files. */
export interface CardSkillOutputs {
  readonly outputs: Readonly<Record<string, JsonSchema | null>>;
  readonly outputFiles?: Readonly<Record<string, Readonly<Record<string, CardFileField>>>>;
}

/** One data schema as a card describes it: the schema, and its file fields when declared apart. */
interface CardSchema {
  readonly schema: JsonSchema | null;
  readonly files?: Readonly<Record<string, CardFileField>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const declarationOf = (field: A2AFileField, mediaTypes: readonly string[]): CardFileField => ({
  list: field.isList,
  optional: field.isOptional,
  mediaTypes,
});

/** A file field's marker: its declaration, and what it holds said in its description. */
function markerOf(field: A2AFileField, schema: unknown, mediaTypes: readonly string[]): JsonSchema {
  const described =
    isRecord(schema) && typeof schema.description === "string" ? schema.description : field.name;
  const parts = field.isList ? "file parts" : "a file part";
  return {
    [FILE_PART_KEYWORD]: declarationOf(field, mediaTypes),
    description: `${described} — sent as ${parts} naming "${field.name}", never in the data part`,
  };
}

/** A data schema with file fields, as the card describes it in `mode`. */
function cardSchemaOf(
  schema: JsonSchema | null,
  fields: readonly A2AFileField[],
  mode: A2ACardFileFields,
  mediaTypes: readonly string[],
): CardSchema {
  if (schema === null || fields.length === 0) return { schema };
  const byName = new Map(fields.map((field) => [field.name, field]));
  const names = new Set(byName.keys());
  if (mode === A2ACardFileFields.Marker) {
    const marker = (name: string, property: unknown): JsonSchema => {
      const field = byName.get(name);
      return field === undefined ? {} : markerOf(field, property, mediaTypes);
    };
    return { schema: withoutFileFields(schema, names, marker) };
  }
  const files = Object.fromEntries(
    fields.map((field) => [field.name, declarationOf(field, mediaTypes)]),
  );
  return { schema: withoutFileFields(schema, names), files };
}

/** The skill's input on its card. */
export function cardSkillInputOf(skill: ServedSkill): CardSkillInput {
  const { cardFileFields } = skill;
  const { schema, files } = cardSchemaOf(
    skill.inputSchema,
    skill.inputFiles,
    cardFileFields,
    skill.fileLimits.allowedMediaTypes,
  );
  return { input: schema, cardFileFields, ...(files === undefined ? {} : { files }) };
}

/** The skill's finishes on its card: each one's output, its file fields as its inputs' are. */
export function cardSkillOutputsOf(skill: ServedSkill): CardSkillOutputs {
  const described = skill.outputs.map((output) => ({
    finish: output.finish,
    ...cardSchemaOf(
      output.schema,
      output.fileFields,
      skill.cardFileFields,
      skill.outputFileMediaTypes,
    ),
  }));
  const outputs = Object.fromEntries(described.map((each) => [each.finish, each.schema]));
  const withFiles = described.flatMap((each) =>
    each.files === undefined ? [] : [[each.finish, each.files] as const],
  );
  return withFiles.length === 0
    ? { outputs }
    : { outputs, outputFiles: Object.fromEntries(withFiles) };
}
