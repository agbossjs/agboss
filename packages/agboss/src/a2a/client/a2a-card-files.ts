import { fieldsOf } from "../../dto/metadata.js";
import type { DtoClass } from "../../dto/types.js";
import { FILE_PART_KEYWORD } from "../a2a-card-file-fields.js";
import { fileFieldsOf, type A2AFileField } from "../files/a2a-file.dto.js";

/**
 * The file fields a skill's card declares (#904), wherever it declares them — the skills
 * extension's `files` (the input) and `outputFiles` (each finish's, #916 item 4) under
 * `A2ACardFileFields.Extension`, or `x-agboss-file-part` markers in the data schema (`Marker`, each
 * carrying its declaration, #916 item 2) — and how the client's DTOs compare with them: the data
 * compared without the file fields, the file fields with the declared ones.
 */

/** One declared file field: whether a list, whether optional — unknown for a bare `true` marker. */
export interface DeclaredFileField {
  readonly list: boolean | undefined;
  readonly optional: boolean | undefined;
}

/** A skill's declared file fields, by name. */
export type DeclaredFileFields = ReadonlyMap<string, DeclaredFileField>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const flagOf = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const declaredOf = (field: Readonly<Record<string, unknown>>): DeclaredFileField => ({
  list: flagOf(field.list),
  optional: flagOf(field.optional),
});

/** The file fields declared apart (`files`), else marked in `schema`'s properties. */
function declaredIn(files: unknown, schema: unknown): DeclaredFileFields {
  const found = new Map<string, DeclaredFileField>();
  if (isRecord(files)) {
    for (const [name, field] of Object.entries(files))
      if (isRecord(field)) found.set(name, declaredOf(field));
    return found;
  }
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  for (const [name, property] of Object.entries(properties)) {
    const marker = isRecord(property) ? property[FILE_PART_KEYWORD] : undefined;
    if (marker === true) found.set(name, { list: undefined, optional: undefined });
    else if (isRecord(marker)) found.set(name, declaredOf(marker));
  }
  return found;
}

/** The file fields a skill's entry of the skills extension declares for its input. */
export const declaredFileFieldsOf = (
  entry: Readonly<Record<string, unknown>>,
): DeclaredFileFields => declaredIn(entry.files, entry.input);

/** The file fields a skill's entry declares for the output of `finish`. */
export function declaredOutputFileFieldsOf(
  entry: Readonly<Record<string, unknown>>,
  finish: string,
): DeclaredFileFields {
  const files = isRecord(entry.outputFiles) ? entry.outputFiles[finish] : undefined;
  const outputs = isRecord(entry.outputs) ? entry.outputs[finish] : undefined;
  return declaredIn(files, outputs);
}

/** How one of the client's input file fields differs from the skill's declaration of it. */
function fieldDifferencesOf(field: A2AFileField, theirs: DeclaredFileField | undefined): string[] {
  const { name } = field;
  if (theirs === undefined)
    return [`input: ${name} is a file field the skill does not take as files`];
  const found: string[] = [];
  if (theirs.list !== undefined && theirs.list !== field.isList)
    found.push(`input: ${name} is ${theirs.list ? "a list of files" : "one file"} on the skill`);
  if (theirs.optional === false && field.isOptional)
    found.push(`input: ${name} is a required file on the skill, optional in the client's input`);
  return found;
}

/** How the client's input file fields differ from the declared ones (`input: …`). */
export function fileFieldDifferencesOf(
  input: DtoClass,
  declared: DeclaredFileFields,
): readonly string[] {
  const own = fileFieldsOf(input);
  const names = new Set(own.map((field) => field.name));
  const missing = [...declared]
    .filter(([name, theirs]) => !names.has(name) && theirs.optional === false)
    .map(
      ([name]) =>
        `input: the skill requires the file field ${name}, which the client's input lacks`,
    );
  return [
    ...own.flatMap((field) => fieldDifferencesOf(field, declared.get(field.name))),
    ...missing,
  ];
}

/** How one of the client's output file fields differs from a finish's declaration of it. */
function outputFieldDifferencesOf(
  field: A2AFileField,
  theirs: DeclaredFileField | undefined,
  where: string,
): string[] {
  const { name } = field;
  if (theirs === undefined)
    return field.isOptional ? [] : [`${where}: ${name} is a file the finish does not give`];
  const found: string[] = [];
  if (theirs.list !== undefined && theirs.list !== field.isList)
    found.push(
      `${where}: ${name} is ${theirs.list ? "a list of files" : "one file"} on the finish`,
    );
  if (theirs.optional === true && !field.isOptional)
    found.push(
      `${where}: ${name} is an optional file of the finish, required in the client's output`,
    );
  return found;
}

/**
 * How the client's output file fields differ from those a finish declares (`output (f): …`): a
 * file it requires must be given, one file or a list as it says; a field the finish gives as files
 * the client must not read as data.
 */
export function outputFileFieldDifferencesOf(
  output: DtoClass,
  declared: DeclaredFileFields,
  finish: string,
): readonly string[] {
  const where = `output (${finish})`;
  const own = fileFieldsOf(output);
  const names = new Set(own.map((field) => field.name));
  const notFiles = fieldsOf(output)
    .map((field) => field.name)
    .filter((name) => declared.has(name) && !names.has(name))
    .map(
      (name) =>
        `${where}: ${name} is a file field of the finish, not a file in the client's output`,
    );
  return [
    ...own.flatMap((field) => outputFieldDifferencesOf(field, declared.get(field.name), where)),
    ...notFiles,
  ];
}
