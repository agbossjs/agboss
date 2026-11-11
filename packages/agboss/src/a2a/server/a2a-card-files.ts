import type { JsonSchema } from "../../dto/schema.js";
import { FILE_PART_KEYWORD, withoutFileFields } from "../a2a-card-file-fields.js";
import { A2ACardFileFields } from "../files/a2a-file-options.js";
import type { ServedSkill } from "./a2a-skills.js";

/**
 * A skill's input as its Agent Card describes it (#904): its file fields are sent as file parts,
 * never in the data part — so the data `input` schema never asks for them. `Extension` leaves them
 * out of it and declares them in the skills extension (`files`); `Marker` keeps each one in it as
 * `{ "x-agboss-file-part": true, description }`, out of `required`.
 */

/** A file field as the skills extension declares it. */
export interface CardFileField {
  readonly list: boolean;
  readonly optional: boolean;
  readonly mediaTypes: readonly string[];
}

/** The skills extension's entry of one skill's input: its data schema, and its files when declared there. */
export interface CardSkillInput {
  readonly input: JsonSchema | null;
  readonly cardFileFields: A2ACardFileFields;
  readonly files?: Readonly<Record<string, CardFileField>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A file field's marker: what it holds, said in its description. */
function markerOf(field: string, schema: unknown, isList: boolean): JsonSchema {
  const described =
    isRecord(schema) && typeof schema.description === "string" ? schema.description : field;
  const parts = isList ? "file parts" : "a file part";
  return {
    [FILE_PART_KEYWORD]: true,
    description: `${described} — sent as ${parts} naming "${field}", never in the data part`,
  };
}

/** The skill's input on its card. */
export function cardSkillInputOf(skill: ServedSkill): CardSkillInput {
  const { inputSchema, inputFiles, cardFileFields } = skill;
  if (inputSchema === null || inputFiles.length === 0)
    return { input: inputSchema, cardFileFields };
  const names = new Set(inputFiles.map((field) => field.name));
  const isMarker = cardFileFields === A2ACardFileFields.Marker;
  const marker = (name: string, property: unknown) =>
    markerOf(name, property, inputFiles.find((field) => field.name === name)?.isList === true);
  const input = withoutFileFields(inputSchema, names, isMarker ? marker : undefined);
  if (isMarker) return { input, cardFileFields };
  const files = Object.fromEntries(
    inputFiles.map((field) => [
      field.name,
      {
        list: field.isList,
        optional: field.isOptional,
        mediaTypes: skill.fileLimits.allowedMediaTypes,
      },
    ]),
  );
  return { input, cardFileFields, files };
}
