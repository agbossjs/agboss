import { createHash } from "node:crypto";
import "../../polyfills/symbol-metadata.js";
import { mediaTypeEssenceOf } from "../../a2a/files/a2a-file-options.js";
import type { WorkflowStartInput } from "../../flow/decorators/workflow-start.js";
import { PiiAction } from "../../pii/actions.js";
import { Integer, List, MediaType, Nested, Text, Url, Validate } from "../decorators.js";
import { fieldsOf } from "../metadata.js";
import type { DtoCheck, DtoClass, FieldDecorator, FieldOptions, OptionalField } from "../types.js";

/** What a file made of bytes or of a URL is named by: its media type and file name. */
export interface FileDtoOptions {
  readonly mediaType: string;
  readonly filename?: string;
}

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/** A file is exactly one of `fileId`, `inline` and `url`; bytes carry their digest and size. */
const fileSourceCheck: DtoCheck<FileDto> = (file) => {
  const sources = [file.fileId, file.inline, file.url].filter((value) => value !== undefined);
  if (sources.length !== 1)
    return { field: "fileId", reason: "a file is exactly one of fileId, inline or url" };
  if (file.url !== undefined)
    return isHttpUrl(file.url)
      ? undefined
      : { field: "url", reason: "a file's url is an http(s) URL" };
  if (file.sha256 === undefined) return { field: "sha256", reason: "a file's bytes need sha256" };
  return file.sizeBytes === undefined
    ? { field: "sizeBytes", reason: "a file's bytes need sizeBytes" }
    : undefined;
};

/**
 * A file of an A2A message or artifact (#859, spec §4.1.6 `Part` with `raw` or `url`), as a step
 * holds it: a descriptor, never a stream — its media type and name, and where its bytes are: in the
 * application's `FileRepository` (`fileId`), inline (`inline`, base64 — a small file kept in the
 * execution's own records when no file store is listed), or elsewhere by reference (`url`). Its
 * bytes are read through the `Files` service, checked against `sha256`. Wherever the value
 * leaves the execution as text (a model's prompt, a tool result, a kept record, an event, a trace)
 * only `redactedFileOf` of it does; its bytes reach a model as a file part, never as text.
 */
@Validate<FileDto>(fileSourceCheck)
export class FileDto {
  @MediaType({ prompt: "the file's media type, e.g. application/pdf" })
  mediaType!: string;

  @Text({ prompt: "the file's name, e.g. report.pdf", optional: true, maxLength: 255 })
  filename?: string;

  @Text({ prompt: "the file's id in the application's file store", optional: true })
  fileId?: string;

  @Text({
    prompt: "the SHA-256 of the file's bytes, in hex",
    optional: true,
    pattern: /^[0-9a-f]{64}$/,
  })
  sha256?: string;

  @Integer({ prompt: "the file's size in bytes", optional: true, min: 0 })
  sizeBytes?: number;

  @Url({ prompt: "where the file is, for a file given by reference", optional: true })
  url?: string;

  @Text({
    prompt: "the file's bytes, base64",
    optional: true,
    pattern: /^[A-Za-z0-9+/]*={0,2}$/,
    sensitive: PiiAction.mask(),
  })
  inline?: string;

  /** A file of these bytes, held inline: its descriptor names their `sha256` and size. */
  static fromBytes(bytes: Uint8Array, options: FileDtoOptions): FileDto {
    return {
      mediaType: mediaTypeEssenceOf(options.mediaType),
      ...(options.filename === undefined ? {} : { filename: options.filename }),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      inline: Buffer.from(bytes).toString("base64"),
    };
  }

  /** A file by reference: its bytes stay at the `url`, fetched under the file policy when read. */
  static fromUrl(url: string, options: FileDtoOptions): FileDto {
    return {
      mediaType: mediaTypeEssenceOf(options.mediaType),
      ...(options.filename === undefined ? {} : { filename: options.filename }),
      url,
    };
  }
}

/** What the `@File` decorator takes: the prompt of the field. */
export type FileFieldOptions = Pick<FieldOptions<FileDto>, "prompt">;

/**
 * A field that holds a file (`photo!: FileDto`, `photo?: FileDto` with `optional: true`); `@List(FileDto, …)`
 * holds a list of them.
 */
export function File(
  options: FileFieldOptions & OptionalField,
): FieldDecorator<FileDto | undefined>;
export function File(
  options?: FileFieldOptions & { readonly optional?: false },
): FieldDecorator<FileDto>;
export function File(
  options: FileFieldOptions & { readonly optional?: boolean } = {},
): FieldDecorator<FileDto> | FieldDecorator<FileDto | undefined> {
  return options.optional === true
    ? Nested(FileDto, { ...options, optional: true })
    : Nested(FileDto, { ...options, optional: false });
}

/** Where a file's bytes are, as its descriptor says. */
export enum FilePayloadSource {
  /** In the application's `FileRepository`, by `fileId`. */
  Stored = "stored",
  /** In the descriptor itself, base64 (`inline`). */
  Inline = "inline",
  /** Elsewhere, by `url`. */
  Url = "url",
}

/** The source of a descriptor the DTO's rule admitted (exactly one is set). */
export function fileSourceOf(file: FileDto): FilePayloadSource {
  if (file.fileId !== undefined) return FilePayloadSource.Stored;
  return file.inline === undefined ? FilePayloadSource.Url : FilePayloadSource.Inline;
}

/**
 * What a file is where it is shown (#899 §0): a prompt, a tool result, `onToolEnd`, a record, an
 * observer event, a log, a trace, a cassette. Never its bytes (`inline`), never where they are
 * (`fileId`, `url`) — only what it is, and which kind of place holds its bytes.
 */
export interface RedactedFile {
  readonly mediaType: string;
  readonly filename?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly source: FilePayloadSource;
}

/** The one scrub of a file descriptor: its metadata and its source, nothing that carries bytes or leads to them. */
export function redactedFileOf(file: FileDto): RedactedFile {
  return {
    mediaType: file.mediaType,
    ...(file.filename === undefined ? {} : { filename: file.filename }),
    ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
    ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
    source: fileSourceOf(file),
  };
}

/** A run that finishes with one file: its artifact is that file's part (#859). */
export class WorkflowFinishFileDto {
  @Nested(FileDto, { prompt: "the file the run finishes with" })
  file!: FileDto;
}

/** A run that finishes with files: its artifact is one part per file, in order (#859). */
export class WorkflowFinishFilesDto {
  @List(FileDto, { prompt: "the files the run finishes with", minItems: 1 })
  files!: FileDto[];
}

/** A field of a DTO that holds files: one (`@Nested(FileDto)`) or a list (`@List`). */
export interface FileField {
  readonly name: string;
  readonly isList: boolean;
  readonly isOptional: boolean;
}

const isFileDto = (dto: DtoClass): boolean => dto === FileDto || dto.prototype instanceof FileDto;

/** The DTO class a start takes as its input; `undefined` for a list or a map of fields, which hold no file field of their own. */
export const inputClassOf = (input: WorkflowStartInput): DtoClass | undefined =>
  typeof input === "function" ? input : undefined;

/** The fields of a DTO that hold files, in declaration order; none for a DTO without. */
export function fileFieldsOf(dto: DtoClass): readonly FileField[] {
  return fieldsOf(dto).flatMap((field) => {
    const { element } = field;
    if (element?.kind !== "dto" || !isFileDto(element.dto)) return [];
    return [{ name: field.name, isList: field.kind === "list-of", isOptional: field.optional }];
  });
}

/** Whether a file sits anywhere in `dto`: a field, or at any depth through nested and listed DTOs. */
export function hasFileAtAnyDepth(dto: DtoClass, seen: ReadonlySet<DtoClass> = new Set()): boolean {
  if (isFileDto(dto)) return true;
  if (seen.has(dto)) return false;
  const visited = new Set([...seen, dto]);
  return fieldsOf(dto).some(
    (field) => field.element?.kind === "dto" && hasFileAtAnyDepth(field.element.dto, visited),
  );
}

/** The paths below `dto` where a file sits under another DTO (`items[].file`); `prefix` is the path so far. */
function filesBelow(dto: DtoClass, prefix: string, seen: ReadonlySet<DtoClass>): string[] {
  return fieldsOf(dto).flatMap((field) => {
    const { element } = field;
    if (element?.kind !== "dto") return [];
    const path = `${prefix}${field.name}${field.kind === "list-of" ? "[]" : ""}`;
    if (isFileDto(element.dto)) return [path];
    if (seen.has(element.dto)) return [];
    return filesBelow(element.dto, `${path}.`, new Set([...seen, element.dto]));
  });
}

/**
 * The fields of a DTO where a file sits below the top level (#859): a file of an A2A message or
 * answer is a part of its own, so only a top-level field holds one — a nested one would travel
 * inside the data part, a descriptor the other side made (`[a2a.nested-file-field]`).
 */
export function nestedFileFieldsOf(dto: DtoClass): readonly string[] {
  return fieldsOf(dto).flatMap((field) => {
    const { element } = field;
    if (element?.kind !== "dto" || isFileDto(element.dto)) return [];
    const path = `${field.name}${field.kind === "list-of" ? "[]" : ""}.`;
    return filesBelow(element.dto, path, new Set([dto, element.dto]));
  });
}
