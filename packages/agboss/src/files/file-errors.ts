import { FileError } from "../core/error-families/remote-errors.js";
import { bytes } from "../units/index.js";
import { StepFailedError, stepCoordinatesOf } from "../graph/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { ModelFileLimit } from "./model-files.js";

/**
 * What stops a file on its way to a model (#899): its bytes cannot be read (`FileError.Unavailable`),
 * the guarded path refuses them (`FileError.Refused`), or they are over a limit of the agent
 * (`ModelFileLimitError`, before any model call, never a silent truncation).
 */

/** Why a file's bytes cannot be read: `FileError.Unavailable`'s `reason`. */
export enum FileUnavailableReason {
  /** No such file in the store for this execution's task (another task's, swept, removed). */
  NotFound = "not-found",
  /** A file by reference (`url`): its bytes are elsewhere, fetched by the step itself. */
  ByReference = "by-reference",
  /** Its bytes do not match the `sha256` its descriptor names. */
  DigestMismatch = "digest-mismatch",
  /** A read outside an execution: a file belongs to its execution's task. */
  OutsideExecution = "outside-execution",
  /** A download larger than its `maxSize`: stopped there. */
  TooLarge = "too-large",
  /** The url did not answer the file: a failure, a timeout, a status. */
  DownloadFailed = "download-failed",
}

/** Why a file is refused: `FileError.Refused`'s `refusal`. */
export enum FileRefusal {
  /** A save outside an execution: a file belongs to its execution's task. */
  OutsideExecution = "outside-execution",
  /** Its media type is not in the policy's `allowedMediaTypes`. */
  MediaType = "media-type",
  /** Its bytes are not of the media type it declares. */
  MediaTypeMismatch = "media-type-mismatch",
  /** It is larger than the policy's `maxFileSize`. */
  TooLarge = "too-large",
  /** A file by reference is on no `https:` URL, or the url is no url, or carries a user or a password. */
  UrlInvalid = "url-invalid",
  /** A file by url with no allowed origins, or from an origin not in them, or a redirect to one. */
  OriginDenied = "origin-denied",
  /** The url's host is an address a file is never fetched from (private, link-local, …). */
  AddressDenied = "address-denied",
}

/** What a refused file is known by. */
export interface FileRefusedOptions {
  readonly refusal: FileRefusal;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly cause?: unknown;
}

/** A file refused (`files.refused`): nothing of its bytes was read or kept. */
export function fileRefused(options: FileRefusedOptions): FileError.Refused {
  const { refusal, mediaType, sizeBytes, cause } = options;
  return new FileError.Refused({
    message: `the file was refused: ${refusal}`,
    refusal,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes: bytes(sizeBytes) }),
    cause,
  });
}

/** A file whose bytes cannot be read (`files.unavailable`). */
export function fileUnavailable(options: {
  readonly reason: FileUnavailableReason;
  readonly cause?: unknown;
}): FileError.Unavailable {
  const { reason, cause } = options;
  return new FileError.Unavailable({
    message: `the file's bytes are unavailable: ${reason}`,
    reason,
    cause,
  });
}

/** A save of a key already kept with other bytes: a file never changes (`files.conflict`). */
export const fileConflict = (options: {
  readonly fileId: string;
  readonly cause?: unknown;
}): FileError.Conflict =>
  new FileError.Conflict({
    message: "a file is saved once: another file is kept under this id",
    ...options,
  });

/** What a file over a limit takes (#906). */
export interface ModelFileLimitErrorOptions {
  readonly agent: string;
  readonly limit: ModelFileLimit;
  /** What it was: a count, a size in bytes, or a media type. */
  readonly actual: number | string;
  /** What is allowed: the limit's value, or the allowed media types. */
  readonly allowed: number | string;
  readonly cause?: unknown;
}

/** A file over a limit of the agent's files, found before any model call (`step.model-file-limit`). */
export class ModelFileLimitError extends StepFailedError {
  static override readonly code = "step.model-file-limit" as const;
  declare readonly code: typeof ModelFileLimitError.code;
  override name = "ModelFileLimitError";
  readonly agent: string;
  readonly limit: ModelFileLimit;
  readonly actual: number | string;
  readonly allowed: number | string;

  constructor(options: ModelFileLimitErrorOptions) {
    const { agent, limit, actual, allowed, cause } = options;
    const said = `${limit}: ${String(actual)} is over ${String(allowed)}`;
    super({
      message: `Agent "${agent}": its files are over a limit — ${said}`,
      usage: [],
      cause: cause ?? said,
      ...stepCoordinatesOf(agent, ComponentKind.Agent),
      details: { agent, limit, actual, allowed },
    });
    this.agent = agent;
    this.limit = limit;
    this.actual = actual;
    this.allowed = allowed;
  }
}

/** What a failed redaction takes (#906). */
export interface FileRedactionFailedErrorOptions {
  readonly agent: string;
  /** What went wrong, in words: the model, its answer, the image, the store. */
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * A redacted copy of a file could not be made (`step.file-redaction-failed`): the redactor failed, its
 * answer was not what it must be, the image could not be read, or the copy could not be kept. Fail
 * closed — the unredacted file never goes to the model in its place, and this is no `PiiRefusedError`
 * (that one is for a block rule whose kind was found).
 */
export class FileRedactionFailedError extends StepFailedError {
  static override readonly code = "step.file-redaction-failed" as const;
  declare readonly code: typeof FileRedactionFailedError.code;
  override name = "FileRedactionFailedError";
  readonly agent: string;
  readonly reason: string;

  constructor(options: FileRedactionFailedErrorOptions) {
    const { agent, reason, cause } = options;
    super({
      message: `Agent "${agent}": a redacted copy of its file could not be made — ${reason}`,
      usage: [],
      cause: cause ?? reason,
      ...stepCoordinatesOf(agent, ComponentKind.Agent),
      details: { agent, reason },
    });
    this.agent = agent;
    this.reason = reason;
  }
}
