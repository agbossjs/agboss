import { AGBossError } from "../core/errors.js";
import { StepFailedError, stepCoordinatesOf } from "../graph/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { ModelFileLimit } from "./model-files.js";

/**
 * What stops a file on its way to a model (#899): its bytes cannot be read (`ModelFileUnavailableError`),
 * the guarded path refuses them (`ModelFileRefusedError`), or they are over a limit of the agent
 * (`ModelFileLimitError`, before any model call, never a silent truncation).
 */

/** Why a file's bytes cannot be read. */
export enum ModelFileUnavailableReason {
  /** The file is no longer kept (another task's, swept, removed). */
  NotFound = "not-found",
  /** Its bytes do not match the `sha256` its descriptor names. */
  DigestMismatch = "digest-mismatch",
  /** The url did not answer the file: a failure, a timeout, a status. */
  DownloadFailed = "download-failed",
  /** A read outside an execution: a file belongs to its execution's task. */
  OutsideExecution = "outside-execution",
}

export interface ModelFileUnavailableErrorOptions {
  readonly reason: ModelFileUnavailableReason;
  readonly cause?: unknown;
}

/** The bytes of a file cannot be read (`model.file-unavailable`). */
export class ModelFileUnavailableError extends AGBossError {
  static override readonly code = "model.file-unavailable" as const;
  declare readonly code: typeof ModelFileUnavailableError.code;
  readonly reason: ModelFileUnavailableReason;

  constructor(options: ModelFileUnavailableErrorOptions) {
    const { reason, cause } = options;
    super(`the file's bytes are unavailable: ${reason}`, { cause, details: { reason } });
    this.reason = reason;
  }
}

/** Why the guarded path refuses a file. */
export enum ModelFileRefusal {
  /** A file by url with no `allowedFileOrigins`, or from an origin not in them, or a redirect to one. */
  OriginDenied = "origin-denied",
  /** The url's host is an address a file is never fetched from (private, link-local, …). */
  AddressDenied = "address-denied",
  /** The url is no url, or carries a user or a password. */
  UrlInvalid = "url-invalid",
  /** The file is larger than the agent's `maxFileSize`. */
  TooLarge = "too-large",
  /** The bytes are not what the declared media type says. */
  MediaTypeMismatch = "media-type-mismatch",
}

export interface ModelFileRefusedErrorOptions {
  readonly refusal: ModelFileRefusal;
  readonly cause?: unknown;
}

/** The guarded path refused a file (`model.file-refused`): nothing of its bytes was read or kept. */
export class ModelFileRefusedError extends AGBossError {
  static override readonly code = "model.file-refused" as const;
  declare readonly code: typeof ModelFileRefusedError.code;
  readonly refusal: ModelFileRefusal;

  constructor(options: ModelFileRefusedErrorOptions) {
    const { refusal, cause } = options;
    super(`the file was refused: ${refusal}`, { cause, details: { refusal } });
    this.refusal = refusal;
  }
}

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
