import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { kilobytes, seconds, type Bytes, type Milliseconds } from "../../units/index.js";

/**
 * How much of what an A2A agent takes as files (#859): `@A2AExpose({ skills: { [id]: { files } } })`
 * over `@Application({ a2aFiles })` over the defaults, field by field — each file at most
 * `maxFileSize`, all of a message's at most `maxTotalFileSize` and `maxFiles`, of a media type in
 * `allowedMediaTypes` (its bytes checked against it: the signature of an image or a PDF, valid UTF-8
 * for a text), by `url` only from an `https:` origin in `allowedFileOrigins`. Fail closed: no
 * origin listed, no file by reference.
 */
export interface A2AFileOptions {
  /** The largest file (`kilobytes(64)` by default). */
  readonly maxFileSize?: Bytes;
  /** The most bytes of all of one message's files (`kilobytes(64)` by default). */
  readonly maxTotalFileSize?: Bytes;
  /** The most files of one message (5 by default). */
  readonly maxFiles?: number;
  /** The media types taken (`DEFAULT_A2A_FILE_MEDIA_TYPES` by default). */
  readonly allowedMediaTypes?: readonly string[];
  /** The `https:` origins a file by `url` is fetched from (`https://files.example`); none by default. */
  readonly allowedFileOrigins?: readonly string[];
}

/** The media types taken by default: images, PDF, plain text, Markdown, CSV and JSON. */
export const DEFAULT_A2A_FILE_MEDIA_TYPES: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/** The limits one skill runs with: every field set. */
export interface A2AFileLimits {
  readonly maxFileSize: Bytes;
  readonly maxTotalFileSize: Bytes;
  readonly maxFiles: number;
  readonly allowedMediaTypes: readonly string[];
  readonly allowedFileOrigins: readonly string[];
}

export const DEFAULT_A2A_FILE_LIMITS: A2AFileLimits = Object.freeze({
  maxFileSize: kilobytes(64),
  maxTotalFileSize: kilobytes(64),
  maxFiles: 5,
  allowedMediaTypes: DEFAULT_A2A_FILE_MEDIA_TYPES,
  allowedFileOrigins: [],
});

/** How long a file by `url` may take to fetch, redirects included (`a2aHttpListener`'s default). */
export const DEFAULT_FILE_FETCH_TIMEOUT: Milliseconds = seconds(10);

/** The limits of a skill: its own fields, else the application's, else the defaults. */
export const fileLimitsOf = (
  application: A2AFileOptions | undefined,
  skill: A2AFileOptions | undefined,
): A2AFileLimits => ({ ...DEFAULT_A2A_FILE_LIMITS, ...application, ...skill });

/** A media type as compared: its essence, lower case (`Text/Plain; charset=utf-8` → `text/plain`). */
export const mediaTypeEssenceOf = (mediaType: string): string =>
  (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase();

const isWhole = (value: unknown, min: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= min;

/** An allowed origin is written as `new URL(…).origin` writes it, on `https:`. */
const isHttpsOrigin = (entry: string): boolean =>
  URL.canParse(entry) && new URL(entry).origin === entry && entry.startsWith("https://");

/** What is wrong with the sizes and the count of one set of file options. */
function limitProblemsOf(options: A2AFileOptions): readonly string[] {
  const sizes = (["maxFileSize", "maxTotalFileSize"] as const).flatMap((field) =>
    options[field] === undefined || isWhole(options[field], 1)
      ? []
      : [`${field} is not a whole number of bytes from 1`],
  );
  const count =
    options.maxFiles === undefined || isWhole(options.maxFiles, 1)
      ? []
      : ["maxFiles is not a whole number from 1"];
  return [...sizes, ...count];
}

/** What is wrong with the media types and origins of one set of file options. */
function listProblemsOf(options: A2AFileOptions): readonly string[] {
  const types = (options.allowedMediaTypes ?? []).flatMap((type) =>
    mediaTypeEssenceOf(type) === type && type.includes("/")
      ? []
      : [`allowedMediaTypes entry "${type}" is not a lower-case type/subtype`],
  );
  const origins = (options.allowedFileOrigins ?? []).flatMap((origin) =>
    isHttpsOrigin(origin)
      ? []
      : [`allowedFileOrigins entry "${origin}" is not an https: origin (no path)`],
  );
  return [...types, ...origins];
}

/** What is wrong with one set of file options, each a text after its place. */
const problemsOf = (options: A2AFileOptions): readonly string[] => [
  ...limitProblemsOf(options),
  ...listProblemsOf(options),
];

/** `[a2a.file-options-invalid]` of the file options found at `where` (the application or a skill). */
export function fileOptionsViolations(
  where: string,
  options: A2AFileOptions | undefined,
  nodes: readonly string[],
): RuleViolation[] {
  if (options === undefined) return [];
  return problemsOf(options).map((problem) =>
    violation("a2a.file-options-invalid", `${where}: ${problem}`, nodes),
  );
}
