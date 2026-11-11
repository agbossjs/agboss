import "../../polyfills/symbol-metadata.js";
import { Integer, ListOf, MediaType, Nested, Text, Url } from "../../dto/decorators.js";
import { fieldsOf } from "../../dto/metadata.js";
import { crossFieldRule } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import { PiiAction } from "../../pii/actions.js";

/**
 * A file of an A2A message or artifact (#859, spec §4.1.6 `Part` with `raw` or `url`), as a step
 * holds it: a descriptor, never a stream — its media type and name, and where its bytes are: in the
 * application's `A2AFileRepository` (`fileId`), inline (`inline`, base64 — a small file kept in the
 * execution's own records when no file store is listed), or elsewhere by reference (`url`). Its
 * bytes are read through the `A2AFiles` service, checked against `sha256`. `inline` is masked
 * wherever the value leaves the execution (a model, a trace, a kept record): only its metadata does.
 */
export class A2AFileDto {
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
    sensitive: PiiAction.replaceWithKind(),
  })
  inline?: string;
}

/** Where a file's bytes are, as its descriptor says. */
export enum A2AFileSource {
  /** In the application's `A2AFileRepository`, by `fileId`. */
  Stored = "stored",
  /** In the descriptor itself, base64 (`inline`). */
  Inline = "inline",
  /** Elsewhere, by `url`. */
  Url = "url",
}

/** The source of a descriptor the DTO's rule admitted (exactly one is set). */
export function fileSourceOf(file: A2AFileDto): A2AFileSource {
  if (file.fileId !== undefined) return A2AFileSource.Stored;
  return file.inline === undefined ? A2AFileSource.Url : A2AFileSource.Inline;
}

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

crossFieldRule(A2AFileDto, (file) => {
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
});

/** A run that finishes with one file: its artifact is that file's part (#859). */
export class WorkflowFinishFileDto {
  @Nested(A2AFileDto, { prompt: "the file the run finishes with" })
  file!: A2AFileDto;
}

/** A run that finishes with files: its artifact is one part per file, in order (#859). */
export class WorkflowFinishFilesDto {
  @ListOf(A2AFileDto, { prompt: "the files the run finishes with", minItems: 1 })
  files!: A2AFileDto[];
}

/** A field of a DTO that holds files: one (`@Nested(A2AFileDto)`) or a list (`@ListOf`). */
export interface A2AFileField {
  readonly name: string;
  readonly isList: boolean;
  readonly isOptional: boolean;
}

const isFileDto = (dto: DtoClass): boolean =>
  dto === A2AFileDto || dto.prototype instanceof A2AFileDto;

/** The fields of a DTO that hold files, in declaration order; none for a DTO without. */
export function fileFieldsOf(dto: DtoClass): readonly A2AFileField[] {
  return fieldsOf(dto).flatMap((field) => {
    const { element } = field;
    if (element?.kind !== "dto" || !isFileDto(element.dto)) return [];
    if (field.kind !== "nested" && field.kind !== "list-of") return [];
    return [{ name: field.name, isList: field.kind === "list-of", isOptional: field.optional }];
  });
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
