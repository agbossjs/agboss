import { createHash } from "node:crypto";
import { A2AFileSource, fileSourceOf, type A2AFileDto } from "../a2a/files/a2a-file.dto.js";
import { mediaTypeEssenceOf } from "../a2a/files/a2a-file-options.js";
import type { FileTransport } from "../a2a/files/a2a-file-transport.js";
import { isOfMediaType } from "../a2a/files/a2a-media-check.js";
import type { A2AFileRepository } from "../infrastructure/a2a-file.repository.js";
import { lazyLoad, type Clock } from "../infrastructure/clock.js";
import type { Bytes, Milliseconds } from "../units/index.js";
import {
  ModelFileRefusal,
  ModelFileRefusedError,
  ModelFileUnavailableError,
  ModelFileUnavailableReason,
} from "./file-errors.js";

/**
 * Reading the bytes of a file for a model (#899 §3): one guarded path out of `a2a/server` — it works
 * under `app.execute`, the CLI and a recovery, with no listener. A stored file is read through the
 * repository for its execution's task, an inline one decoded, one by url fetched through the #859 /
 * #904 guarded fetch (`allowedFileOrigins` of `@Application({ a2aFiles })`, no private address, no
 * userinfo, redirects checked, bounded size and time). Whatever its source, the bytes are checked
 * against the descriptor's digest and the media type they declare, and their `sha256` is computed:
 * the digest every later use of the file (a transcription's cache key, a cassette) names.
 */

/** A file's bytes with what names them. */
export interface FileContent {
  readonly mediaType: string;
  readonly filename?: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** What a read is bound by. */
export interface FileReadContext {
  readonly store: A2AFileRepository;
  readonly tenantId: string;
  /** The root execution: a stored file is its task's. */
  readonly ownerId: string;
  readonly signal: AbortSignal;
  readonly clock: Pick<Clock, "sleep" | "now">;
  readonly transport: FileTransport;
  /** The `https:` origins a file by url is fetched from; none: no file by url. */
  readonly allowedOrigins: readonly string[];
  readonly fetchTimeout: Milliseconds;
  /** The largest file: a download is cut at it. */
  readonly maxFileSize: Bytes;
}

export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const REFUSALS: Readonly<Record<string, ModelFileRefusal>> = {
  "a2a.file-origin-denied": ModelFileRefusal.OriginDenied,
  "a2a.file-url-not-allowed": ModelFileRefusal.OriginDenied,
  "a2a.file-address-denied": ModelFileRefusal.AddressDenied,
  "a2a.file-url-invalid": ModelFileRefusal.UrlInvalid,
  "a2a.file-too-large": ModelFileRefusal.TooLarge,
};

/** The stable code of the fetch's refusal (an `A2AError`'s metadata). */
function codeOf(error: unknown): string | undefined {
  const metadata: unknown =
    typeof error === "object" ? Reflect.get(error ?? {}, "metadata") : undefined;
  const code: unknown =
    typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The bytes of a file by url, through the guarded fetch; its refusals as this module's errors. */
async function downloaded(url: string, context: FileReadContext): Promise<Uint8Array> {
  try {
    // loaded at the first download: the fetch's tracing is not part of the root import (#899)
    const { fetchedFile } = await lazyLoad(import("../a2a/files/a2a-file-fetch.js"));
    return await fetchedFile({
      url,
      allowedOrigins: context.allowedOrigins,
      maxBytes: context.maxFileSize,
      transport: context.transport,
      clock: context.clock,
      timeout: context.fetchTimeout,
      signal: context.signal,
    });
  } catch (error) {
    const refusal = REFUSALS[codeOf(error) ?? ""];
    if (refusal !== undefined) throw new ModelFileRefusedError({ refusal, cause: error });
    throw new ModelFileUnavailableError({
      reason: ModelFileUnavailableReason.DownloadFailed,
      cause: error,
    });
  }
}

/** The bytes of a stored file of the context's task. */
async function stored(file: A2AFileDto, context: FileReadContext): Promise<Uint8Array> {
  const key = { tenantId: context.tenantId, fileId: file.fileId ?? "" };
  const meta = await context.store.findMetadata(key);
  const bytes = meta?.ownerId === context.ownerId ? await context.store.findBytes(key) : undefined;
  if (bytes === undefined)
    throw new ModelFileUnavailableError({ reason: ModelFileUnavailableReason.NotFound });
  return bytes;
}

const sourced = (file: A2AFileDto, context: FileReadContext): Promise<Uint8Array> => {
  switch (fileSourceOf(file)) {
    case A2AFileSource.Url:
      return downloaded(file.url ?? "", context);
    case A2AFileSource.Inline:
      return Promise.resolve(new Uint8Array(Buffer.from(file.inline ?? "", "base64")));
    case A2AFileSource.Stored:
      return stored(file, context);
  }
};

/**
 * A file's content: read once, whatever its source, and checked — its size against `maxFileSize`,
 * its digest against its descriptor's, its bytes against its media type.
 */
export async function fileContentOf(
  file: A2AFileDto,
  context: FileReadContext,
): Promise<FileContent> {
  const bytes = await sourced(file, context);
  if (bytes.byteLength > context.maxFileSize)
    throw new ModelFileRefusedError({ refusal: ModelFileRefusal.TooLarge });
  const sha256 = sha256Of(bytes);
  if (file.sha256 !== undefined && file.sha256 !== sha256)
    throw new ModelFileUnavailableError({ reason: ModelFileUnavailableReason.DigestMismatch });
  const mediaType = mediaTypeEssenceOf(file.mediaType);
  if (!isOfMediaType(mediaType, bytes))
    throw new ModelFileRefusedError({ refusal: ModelFileRefusal.MediaTypeMismatch });
  return {
    mediaType,
    ...(file.filename === undefined ? {} : { filename: file.filename }),
    bytes,
    sha256,
  };
}
