import { AGBossError } from "../../core/errors.js";

/** Why a step could not save a file (#859). */
export enum A2AFileRefusal {
  /** A save outside an execution: a file belongs to its execution's task. */
  OutsideExecution = "outside-execution",
  /** Its media type is not in `@Application({ a2aFiles: { allowedMediaTypes } })`. */
  MediaType = "media-type",
  /** Its bytes are not of the media type it declares. */
  MediaTypeMismatch = "media-type-mismatch",
  /** It is larger than `@Application({ a2aFiles: { maxFileSize } })`. */
  TooLarge = "too-large",
  /** A file by reference is on no `https:` URL. */
  UrlInvalid = "url-invalid",
}

/** What a refused file is known by. */
export interface A2AFileRefusedErrorOptions {
  readonly refusal: A2AFileRefusal;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
}

/** `A2AFiles.save` / `.fromUrl` refused a file (`a2a.file-refused`): nothing was kept. */
export class A2AFileRefusedError extends AGBossError {
  static override readonly code: string = "a2a.file-refused";
  readonly refusal: A2AFileRefusal;

  constructor(options: A2AFileRefusedErrorOptions) {
    super(`the file was refused: ${options.refusal}`, {
      details: {
        refusal: options.refusal,
        ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
        ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }),
      },
    });
    this.refusal = options.refusal;
  }
}

/** Why a file's bytes cannot be read (#859). */
export enum A2AFileUnavailableReason {
  /** No such file in the store for this execution's task (another task's, or swept). */
  NotFound = "not-found",
  /** A file by reference (`url`): its bytes are elsewhere, fetched by the step itself. */
  ByReference = "by-reference",
  /** Its bytes do not match the `sha256` its descriptor names. */
  DigestMismatch = "digest-mismatch",
  /** A read outside an execution. */
  OutsideExecution = "outside-execution",
  /** A download larger than its `maxSize`: stopped there. */
  TooLarge = "too-large",
  /** A download the agent's origin did not answer with the file. */
  DownloadFailed = "download-failed",
}

/** `A2AFiles.read` found no bytes it may give (`a2a.file-unavailable`). */
export class A2AFileUnavailableError extends AGBossError {
  static override readonly code: string = "a2a.file-unavailable";
  readonly reason: A2AFileUnavailableReason;

  constructor(reason: A2AFileUnavailableReason) {
    super(`the file's bytes are unavailable: ${reason}`, { details: { reason } });
    this.reason = reason;
  }
}
