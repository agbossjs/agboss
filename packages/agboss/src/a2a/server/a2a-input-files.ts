import type { A2AFileDto, A2AFileField } from "../files/a2a-file.dto.js";
import type { AdmittedFile } from "./a2a-file-admission.js";
import { invalidParams } from "./a2a-wire-errors.js";

/**
 * Where a message's files go in its input (#859): each into the field it names
 * (`metadata[A2A_SKILLS_EXTENSION].field`); the ones that name none — a foreign client's — in
 * order into the fields in declaration order: each `@Nested(A2AFileDto)` not filled yet takes one,
 * the first `@ListOf(A2AFileDto)` the rest. A file left over is `-32602
 * a2a.too-many-files-for-field`. The `data` part never fills a file field itself (`-32602
 * a2a.file-field-in-data`): a file's descriptor is the server's, made at its admission, never the
 * caller's — so no caller names a file it did not send.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tooMany = () =>
  invalidParams("a2a.too-many-files-for-field", "more files than the input's fields take");

/** The files that name their field, by field; the others, in order. */
function namedOf(fields: readonly A2AFileField[], files: readonly AdmittedFile[]) {
  const byField = new Map<A2AFileField, A2AFileDto[]>(fields.map((field) => [field, []]));
  const unnamed: A2AFileDto[] = [];
  for (const file of files) {
    const named =
      file.field === undefined ? undefined : fields.find((field) => field.name === file.field);
    if (file.field !== undefined && named === undefined)
      throw invalidParams("a2a.unknown-file-field", "a file names a field that takes no file");
    if (named === undefined) unnamed.push(file.file);
    else byField.get(named)?.push(file.file);
  }
  return { byField, unnamed };
}

/** The files each field gets: the named ones first, then the others in order. */
function filesByField(
  fields: readonly A2AFileField[],
  files: readonly AdmittedFile[],
): Map<A2AFileField, A2AFileDto[]> {
  const { byField, unnamed } = namedOf(fields, files);
  for (const field of fields) {
    const given = byField.get(field) ?? [];
    if (field.isList) given.push(...unnamed.splice(0));
    else if (given.length === 0) given.push(...unnamed.splice(0, 1));
    if (!field.isList && given.length > 1) throw tooMany();
  }
  if (unnamed.length > 0) throw tooMany();
  return byField;
}

/** The input with its files in their fields; `data` as it is when it is no object. */
export function withFilesOf(
  data: unknown,
  fields: readonly A2AFileField[],
  files: readonly AdmittedFile[],
): unknown {
  if (!isRecord(data)) return data;
  if (fields.some((field) => Object.hasOwn(data, field.name)))
    throw invalidParams("a2a.file-field-in-data", "a file field is filled by file parts only");
  const filled: Record<string, unknown> = { ...data };
  for (const [field, given] of filesByField(fields, files)) {
    if (given.length === 0) continue;
    filled[field.name] = field.isList ? given : given[0];
  }
  return filled;
}
