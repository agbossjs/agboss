import { A2AFileDto, hasFileAtAnyDepth, redactedFileOf } from "../a2a/files/a2a-file.dto.js";
import { isFileDescriptor } from "../a2a/files/a2a-file-scrub.js";
import { fieldsOf } from "../dto/metadata.js";
import type { JsonSchema } from "../dto/schema.js";
import type { DtoClass, FieldSpec } from "../dto/types.js";
import type { A2AFileRepository } from "../infrastructure/a2a-file.repository.js";
import type { SeenFile } from "./visit-files.js";

/**
 * The files of an agent's answer (#899 §8). With `AnswerFiles.SeenInVisit` (the default) the answer
 * tool's schema takes a file as `{ file: <n> }` — the number in the headings the model was shown — and the
 * number is mapped back to the descriptor the framework holds: the model never writes a descriptor. With
 * `AnswerFiles.Any` the model's own descriptors are validated like any DTO, and a `url` must be `https:`
 * on `allowedFileOrigins`, a `fileId` one the root execution owns.
 */

const isFileDto = (dto: DtoClass): boolean =>
  dto === A2AFileDto || dto.prototype instanceof A2AFileDto;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What is done to the value where a file sits: a replacement for it. */
export type FileMapper = (file: unknown) => unknown;

/** One field's value with its files replaced: a file, a list of them, or a nested DTO's. */
function mappedField(field: FieldSpec, held: unknown, map: FileMapper): unknown {
  const { element } = field;
  if (element?.kind !== "dto") return held;
  const one = (item: unknown): unknown =>
    isFileDto(element.dto) ? map(item) : mapFileFields(element.dto, item, map);
  if (field.kind === "list-of") return Array.isArray(held) ? held.map(one) : held;
  // a field with a DTO element is `list-of` (above) or `nested` (decorators.ts)
  return one(held);
}

/** The DTO's value with every file replaced by `map(file)`, at any depth: nested DTOs and lists of them. */
export function mapFileFields(dto: DtoClass, value: unknown, map: FileMapper): unknown {
  if (!isRecord(value) || !hasFileAtAnyDepth(dto)) return value;
  const mapped: Record<string, unknown> = { ...value };
  for (const field of fieldsOf(dto)) {
    const held = mapped[field.name];
    if (held !== undefined && held !== null) mapped[field.name] = mappedField(field, held, map);
  }
  return mapped;
}

/** The descriptors in a validated value, in field order. */
export function answerFilesOf(dto: DtoClass, value: unknown): readonly A2AFileDto[] {
  const found: A2AFileDto[] = [];
  mapFileFields(dto, value, (file) => {
    if (isFileDescriptor(file)) found.push(file);
    return file;
  });
  return found;
}

/** The value as it may be shown (a guardrail's text, a record): each file as `redactedFileOf` shows it, never its bytes. */
export const shownAnswerOf = (dto: DtoClass, value: unknown): unknown =>
  mapFileFields(dto, value, (file): unknown =>
    isFileDescriptor(file) ? redactedFileOf(file) : file,
  );

/** What a number the model gave is: the descriptor of that file, or why it cannot be returned. */
export type FilePick =
  | { readonly kind: "file"; readonly file: A2AFileDto }
  | { readonly kind: "problem"; readonly problem: string };

/** What picks a file by its number. */
export interface FilePicker {
  readonly pick: (number: number) => FilePick;
}

/**
 * The picker over the files the model saw: number n is the n-th source file of the visit. The original
 * descriptor is returned only when `Original` was among the views the model read — a file it saw only as
 * a transcription cannot be returned.
 */
export function seenPicker(seen: readonly SeenFile[], isOriginalSeen: boolean): FilePicker {
  return {
    pick: (number) => {
      const found = seen[number - 1];
      if (found === undefined)
        return {
          kind: "problem",
          problem: `there is no file ${String(number)}: the files you were shown are numbered 1 to ${String(seen.length)}`,
        };
      if (!isOriginalSeen)
        return {
          kind: "problem",
          problem: `file ${String(number)} was shown to you only as a transcription, so it cannot be returned`,
        };
      // handed on with the digest of the bytes it was read as: a later read is pinned to it
      const { descriptor } = found.source;
      return {
        kind: "file",
        file:
          descriptor.sha256 === undefined
            ? Object.assign({}, descriptor, { sha256: found.digest })
            : descriptor,
      };
    },
  };
}

const NOT_A_PICK =
  'a file in the answer is given as { "file": <number> } — the number of one of the files you were shown';

/** The mapper that turns `{ file: <n> }` into the descriptor the picker holds; anything else is no answer. */
export function pickingMapper(picker: FilePicker): FileMapper {
  return (given) => {
    if (!isRecord(given)) throw new Error(NOT_A_PICK);
    const keys = Object.keys(given);
    const number = given.file;
    if (keys.length !== 1 || keys[0] !== "file" || !Number.isInteger(number) || Number(number) < 1)
      throw new Error(NOT_A_PICK);
    const picked = picker.pick(Number(number));
    if (picked.kind === "problem") throw new Error(picked.problem);
    return picked.file;
  };
}

/** What a file in an answer tool's schema is: the number the model picked it by. */
const PICK_SCHEMA = {
  type: "object",
  properties: {
    file: {
      type: "integer",
      minimum: 1,
      description:
        "the number of the file, as in the headings of the files you were shown (file 3 of 5)",
    },
  },
  required: ["file"],
  additionalProperties: false,
} as const;

const isSchema = (value: unknown): value is Readonly<Record<string, unknown>> => isRecord(value);

/** One property of a schema with the file in it replaced, its description kept. */
function pickedSchemaOf(schema: unknown, element: DtoClass, isList: boolean): unknown {
  if (!isSchema(schema)) return schema;
  if (isList) return { ...schema, items: pickedSchemaOf(schema.items, element, false) };
  if (isFileDto(element)) {
    const { description } = schema;
    return typeof description === "string" ? { ...PICK_SCHEMA, description } : PICK_SCHEMA;
  }
  return withPickedFiles(element, schema);
}

/**
 * A DTO's JSON schema with every `A2AFileDto` field — at any depth — taking `{ file: <n> }` instead
 * of a descriptor (`AnswerFiles.SeenInVisit`). What the model reads; the answer is checked against the
 * same rule, so a schema shape this cannot reach (a recursive `$ref`) is still no way to write a descriptor.
 */
export function withPickedFiles(dto: DtoClass, schema: JsonSchema): JsonSchema {
  const properties = schema.properties;
  if (!hasFileAtAnyDepth(dto) || !isSchema(properties)) return schema;
  const replaced: Record<string, unknown> = { ...properties };
  for (const field of fieldsOf(dto)) {
    const { element } = field;
    if (element?.kind !== "dto" || !hasFileAtAnyDepth(element.dto)) continue;
    // a field with a DTO element is `nested` or `list-of` (decorators.ts)
    replaced[field.name] = pickedSchemaOf(
      properties[field.name],
      element.dto,
      field.kind === "list-of",
    );
  }
  return { ...schema, properties: replaced };
}

/** Why a descriptor the model wrote is not allowed back; `undefined` when it is (`AnswerFiles.Any`). */
export interface AnswerFileCheck {
  readonly allowedOrigins: readonly string[];
  readonly store: Pick<A2AFileRepository, "findMetadata">;
  readonly tenantId: string;
  /** The root execution: a stored file must be its own. */
  readonly ownerId: string;
}

const originProblemOf = (text: string, allowed: readonly string[]): string | undefined => {
  if (!URL.canParse(text)) return "its url is not a URL";
  const url = new URL(text);
  if (url.username !== "" || url.password !== "") return "its url carries a user or a password";
  if (url.protocol !== "https:") return "its url is not https:";
  return allowed.includes(url.origin) ? undefined : "its url's origin is not allowed";
};

/** The first problem of the answer's files that the model wrote itself; none when every one may travel. */
export async function modelWrittenFileProblem(
  files: readonly A2AFileDto[],
  check: AnswerFileCheck,
): Promise<string | undefined> {
  for (const [index, file] of files.entries()) {
    // which file, never what the model wrote of it: a name can be personal data
    const name = `${String(index + 1)} of ${String(files.length)}`;
    if (file.url !== undefined) {
      const problem = originProblemOf(file.url, check.allowedOrigins);
      if (problem !== undefined) return `answer file ${name} is not allowed: ${problem}`;
    }
    if (file.fileId !== undefined) {
      const kept = await check.store.findMetadata({
        tenantId: check.tenantId,
        fileId: file.fileId,
      });
      if (kept?.ownerId !== check.ownerId)
        return `answer file ${name} is not allowed: it is not one this execution holds`;
    }
  }
  return undefined;
}
