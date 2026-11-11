import type { DtoClass } from "../../dto/types.js";
import { FILE_PART_KEYWORD } from "../a2a-card-file-fields.js";
import { fileFieldsOf, type A2AFileField } from "../files/a2a-file.dto.js";

/**
 * The file fields a skill's card declares (#904), wherever it declares them — the skills
 * extension's `files` (`A2ACardFileFields.Extension`), or `x-agboss-file-part` markers in its data
 * `input` schema (`Marker`) — and how the client's input DTO compares with them: its data compared
 * without its file fields, its file fields with the declared ones.
 */

/** One declared file field: whether a list, whether optional — unknown for a marker. */
export interface DeclaredFileField {
  readonly list: boolean | undefined;
  readonly optional: boolean | undefined;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const flagOf = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** The file fields a skill's entry of the skills extension declares, by name. */
export function declaredFileFieldsOf(
  entry: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, DeclaredFileField> {
  const found = new Map<string, DeclaredFileField>();
  if (isRecord(entry.files)) {
    for (const [name, field] of Object.entries(entry.files))
      if (isRecord(field))
        found.set(name, { list: flagOf(field.list), optional: flagOf(field.optional) });
    return found;
  }
  const properties =
    isRecord(entry.input) && isRecord(entry.input.properties) ? entry.input.properties : {};
  for (const [name, property] of Object.entries(properties))
    if (isRecord(property) && property[FILE_PART_KEYWORD] === true)
      found.set(name, { list: undefined, optional: undefined });
  return found;
}

/** How one of the client's file fields differs from the skill's declaration of it. */
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

/** How the client's file fields differ from the declared ones (`input: …`). */
export function fileFieldDifferencesOf(
  input: DtoClass,
  declared: ReadonlyMap<string, DeclaredFileField>,
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
