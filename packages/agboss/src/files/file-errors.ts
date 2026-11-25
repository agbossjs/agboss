import { FileError } from "../core/error-families/remote-errors.js";
import { bytes } from "../units/index.js";

/**
 * What stops a file on its way to a model (#899): its bytes cannot be read (`FileError.Unavailable`),
 * the guarded path refuses them (`FileError.Refused`), or they are over a limit of the agent
 * (`StepError.ModelFileLimit`, before any model call, never a silent truncation).
 */

/** Why a file's bytes cannot be read: `FileError.Unavailable`'s `reason`. */
export enum FileUnavailableReason {
  /** No such file in the store for this execution's task (another task's, swept, removed). */
  NotFound = "not-found",
  /** Its bytes do not match the `sha256` its descriptor names. */
  DigestMismatch = "digest-mismatch",
  /** A stored or inline file's descriptor names no `sha256`: only a file by url may go unchecked. */
  DigestMissing = "digest-missing",
  /** A read outside an execution: a file belongs to its execution's task. */
  OutsideExecution = "outside-execution",
  /** A download larger than its `maxSize`: stopped there. */
  TooLarge = "too-large",
  /** The url did not answer the file: a failure, a timeout, a status. */
  DownloadFailed = "download-failed",
  /**
   * The fetch pool is saturated (#1316): too many files by url are being fetched now — the
   * policy's `fetchPool`, or the application's shared one. Nothing was asked of the url: retry later.
   */
  FetchBusy = "fetch-busy",
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
  /** A `Files.save({ ttl })` longer than its workflow's `@FilePolicy.ttl`. */
  TtlAbovePolicy = "ttl-above-policy",
  /** Bytes held inline over the cap (64 KB a file, 256 KB a payload) and no file store to offload them to. */
  InlineTooLarge = "inline-too-large",
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
