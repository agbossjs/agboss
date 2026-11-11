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
  static override readonly code = "a2a.file-refused" as const;
  readonly refusal: A2AFileRefusal;
  /** The media type it declared, when that is why (#890: each option is a field). */
  readonly mediaType: string | undefined;
  /** Its size, when that is why. */
  readonly sizeBytes: number | undefined;

  constructor(options: A2AFileRefusedErrorOptions) {
    const { refusal, mediaType, sizeBytes } = options;
    super(`the file was refused: ${refusal}`, {
      details: {
        refusal,
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      },
    });
    this.refusal = refusal;
    this.mediaType = mediaType;
    this.sizeBytes = sizeBytes;
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
  static override readonly code = "a2a.file-unavailable" as const;
  readonly reason: A2AFileUnavailableReason;

  constructor(reason: A2AFileUnavailableReason) {
    super(`the file's bytes are unavailable: ${reason}`, { details: { reason } });
    this.reason = reason;
  }
}
