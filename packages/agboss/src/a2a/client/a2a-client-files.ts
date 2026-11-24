import type { Part } from "@a2a-js/sdk";
import type { DtoClass } from "../../dto/types.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import {
  FilePayloadSource,
  fileFieldsOf,
  fileSourceOf,
  WorkflowFinishFileDto,
  WorkflowFinishFilesDto,
  FileDto,
  type FileField,
} from "../../dto/standard/file.js";
import { mediaTypeEssenceOf } from "../files/a2a-file-options.js";

/**
 * Files on the client's side (#859): what `execute(input)` sends for an input DTO's file fields —
 * one file part each (`raw` bytes, or `url`), naming its field in
 * `metadata[A2A_SKILLS_EXTENSION].field`, then one `data` part of the other fields — and what an
 * answer's file parts give back for the output DTO: each into the field it names, else (a foreign
 * agent's parts name none) into `WorkflowFinishFileDto.file` / `WorkflowFinishFilesDto.files`, or
 * the DTO's only file field.
 */

/** The A2A wire's `Part` of a file (#859, #1316). */
export const A2APart = {
  /** The part of a file whose bytes are at hand (inline) or elsewhere (`url`), for `send(parts)`. */
  fromFile(file: FileDto, field?: string): Part {
    const content: Part["content"] =
      fileSourceOf(file) === FilePayloadSource.Url
        ? { $case: "url", value: file.url ?? "" }
        : { $case: "raw", value: Buffer.from(file.inline ?? "", "base64") };
    return {
      content,
      metadata: field === undefined ? undefined : { [A2A_SKILLS_EXTENSION]: { field } },
      filename: file.filename ?? "",
      mediaType: file.mediaType,
    };
  },
} as const;

/** How a step's stored file (`fileId`) is read before it is sent: `Files.read`. */
export type StoredFileReader = (file: FileDto) => Promise<Uint8Array>;

/** A descriptor with its bytes at hand: a stored one read, any other as it is. */
async function sendableOf(file: FileDto, read: StoredFileReader): Promise<FileDto> {
  if (fileSourceOf(file) !== FilePayloadSource.Stored) return file;
  const bytes = await read(file);
  return FileDto.fromBytes(bytes, {
    mediaType: file.mediaType,
    ...(file.filename === undefined ? {} : { filename: file.filename }),
  });
}

const filesIn = (value: unknown): readonly FileDto[] => {
  if (value === undefined || value === null) return [];
  // the input was validated as its DTO: the field holds descriptors
  return (Array.isArray(value) ? value : [value]) as FileDto[];
};

/** The parts of an input DTO with files: its file parts, then a `data` part of the rest. */
export async function fileInputPartsOf(
  dto: DtoClass,
  input: object,
  read: StoredFileReader,
  dataPart: (value: unknown) => Part,
): Promise<Part[] | undefined> {
  const fields = fileFieldsOf(dto);
  if (fields.length === 0) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  const parts: Part[] = [];
  for (const field of fields)
    for (const file of filesIn(record[field.name]))
      parts.push(A2APart.fromFile(await sendableOf(file, read), field.name));
  const rest = Object.fromEntries(
    Object.entries(record).filter(([name]) => !fields.some((field) => field.name === name)),
  );
  return Object.keys(rest).length === 0 ? parts : [...parts, dataPart(rest)];
}

/** A file part as the client receives it; `undefined` for any other part. */
export function receivedFileOf(part: Part): FileDto | undefined {
  const { content } = part;
  if (content?.$case !== "raw" && content?.$case !== "url") return undefined;
  const named = part.filename === "" ? {} : { filename: part.filename };
  const mediaType = mediaTypeEssenceOf(part.mediaType);
  if (content.$case === "url") return { mediaType, ...named, url: content.value };
  return FileDto.fromBytes(new Uint8Array(content.value), { mediaType, ...named });
}

/** The field a received file part names. */
function namedFieldOf(part: Part): string | undefined {
  const meta: unknown = part.metadata?.[A2A_SKILLS_EXTENSION];
  const field: unknown =
    typeof meta === "object" && meta !== null ? Reflect.get(meta, "field") : undefined;
  return typeof field === "string" ? field : undefined;
}

/** The field an unnamed file goes into: a standard file finish's, else the DTO's only one. */
const defaultFieldOf = (dto: DtoClass, fields: readonly FileField[]): FileField | undefined =>
  dto === WorkflowFinishFileDto || dto === WorkflowFinishFilesDto || fields.length === 1
    ? fields[0]
    : undefined;

/**
 * Whether an answer's `data` part fills a file field itself (#859): a descriptor is never taken
 * from a remote's data — a `fileId` would name a file of the caller's own store — only from file
 * parts; such an answer gives no output.
 */
export function hasFileFieldInData(
  dto: DtoClass,
  data: { readonly value: unknown } | undefined,
): boolean {
  const value = data?.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return fileFieldsOf(dto).some((field) => Object.hasOwn(value, field.name));
}

/**
 * The output of an answer's parts for a DTO with file fields: the `data` part's value (none: `{}`
 * for a DTO of files only) with each file in its field; `undefined` when the parts give no output.
 */
export function fileOutputOf(
  dto: DtoClass,
  parts: readonly Part[],
  data: { readonly value: unknown } | undefined,
): { readonly value: unknown } | undefined {
  const fields = fileFieldsOf(dto);
  const files = parts.flatMap((part) => {
    const file = receivedFileOf(part);
    return file === undefined ? [] : [{ part, file }];
  });
  if (fields.length === 0 || (files.length === 0 && data === undefined)) return undefined;
  const base: unknown = data?.value ?? {};
  if (typeof base !== "object" || base === null) return data;
  return {
    value: {
      ...(base as Readonly<Record<string, unknown>>),
      ...filledFieldsOf(dto, fields, files),
    },
  };
}

/** Each file field with the files its parts name (or, naming none, its default field's). */
function filledFieldsOf(
  dto: DtoClass,
  fields: readonly FileField[],
  files: readonly { readonly part: Part; readonly file: FileDto }[],
): Record<string, unknown> {
  const byField = new Map<string, FileDto[]>();
  for (const { part, file } of files) {
    const named = namedFieldOf(part);
    const field = fields.find((each) => each.name === named) ?? defaultFieldOf(dto, fields);
    if (field !== undefined) byField.set(field.name, [...(byField.get(field.name) ?? []), file]);
  }
  return Object.fromEntries(
    fields.flatMap((field) => {
      const given = byField.get(field.name);
      if (given === undefined) return [];
      return [[field.name, field.isList ? given : given[0]] as const];
    }),
  );
}
