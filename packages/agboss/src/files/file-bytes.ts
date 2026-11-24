import { createHash } from "node:crypto";
import type { FileDto } from "../dto/standard/file.js";
import { mediaTypeEssenceOf } from "../a2a/files/a2a-file-options.js";
import type { FileCaller, FileFetchSlots } from "../a2a/files/a2a-file-slots.js";
import type { FileTransport } from "../a2a/files/a2a-file-transport.js";
import { isOfMediaType } from "../a2a/files/a2a-media-check.js";
import type { FileRepository } from "../infrastructure/file.repository.js";
import { lazyLoad, type Clock } from "../infrastructure/clock.js";
import type { Bytes, Milliseconds } from "../units/index.js";
import { FileRefusal, fileRefused, fileUnavailable, FileUnavailableReason } from "./file-errors.js";

/**
 * Reading the bytes of a file for a model (#899 §3): one guarded path out of `a2a/server` — it works
 * under `app.execute`, the CLI and a recovery, with no listener. A stored file is read through the
 * repository for its execution's task, an inline one decoded, one by url fetched through the #859 /
 * #904 guarded fetch (`allowedOrigins` of the workflow's `@FilePolicy`, no private address, no
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
  readonly store: FileRepository;
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
  /** The application's slots for fetches by url (shared with its A2A listeners); none: unbounded. */
  readonly slots?: FileFetchSlots;
  /** Whose read it is, for the slots' shares: its tenant and its owner inside it. */
  readonly caller?: FileCaller;
}

export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The fetch's refusals by code — a `Map`: an inherited key (`toString`) of an object is no refusal. */
const REFUSALS: ReadonlyMap<unknown, FileRefusal> = new Map([
  ["a2a.file-origin-denied", FileRefusal.OriginDenied],
  ["a2a.file-url-not-allowed", FileRefusal.OriginDenied],
  ["a2a.file-address-denied", FileRefusal.AddressDenied],
  ["a2a.file-url-invalid", FileRefusal.UrlInvalid],
  ["a2a.file-too-large", FileRefusal.TooLarge],
]);

/** The code of the fetch pool's refusal (an `A2AError`'s metadata). */
const FETCH_BUSY = "a2a.file-fetch-busy";

/** The stable code of the fetch's refusal (an `A2AError`'s metadata). */
function codeOf(error: unknown): unknown {
  const metadata: unknown =
    typeof error === "object" ? Reflect.get(error ?? {}, "metadata") : undefined;
  return typeof metadata === "object" && metadata !== null
    ? Reflect.get(metadata, "code")
    : undefined;
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
      slots: context.slots,
      caller: context.caller,
    });
  } catch (error) {
    const refusal = REFUSALS.get(codeOf(error));
    if (refusal !== undefined) throw fileRefused({ refusal, cause: error });
    // the pool's refusal, whichever path asked: one error for all of them (#1316)
    if (codeOf(error) === FETCH_BUSY)
      throw fileUnavailable({ reason: FileUnavailableReason.FetchBusy, cause: error });
    throw fileUnavailable({
      reason: FileUnavailableReason.DownloadFailed,
      cause: error,
    });
  }
}

/** The bytes of a stored file of the context's task. */
async function stored(fileId: string, context: FileReadContext): Promise<Uint8Array> {
  const key = { tenantId: context.tenantId, fileId };
  const meta = await context.store.findMetadata(key);
  const bytes = meta?.ownerId === context.ownerId ? await context.store.findBytes(key) : undefined;
  if (bytes === undefined) throw fileUnavailable({ reason: FileUnavailableReason.NotFound });
  return bytes;
}

/** The bytes by the descriptor's one source (`fileSourceOf`'s order: a stored id, inline bytes, a url). */
const sourced = (file: FileDto, context: FileReadContext): Promise<Uint8Array> => {
  if (file.fileId !== undefined) return stored(file.fileId, context);
  if (file.inline !== undefined)
    return Promise.resolve(new Uint8Array(Buffer.from(file.inline, "base64")));
  // a descriptor has one source (checked when it came in); none reads as an invalid url, refused
  return downloaded(String(file.url), context);
};

/**
 * A file's content: read once, whatever its source, and checked — its size against `maxFileSize`,
 * its digest against its descriptor's, its bytes against its media type.
 */
export async function fileContentOf(file: FileDto, context: FileReadContext): Promise<FileContent> {
  const bytes = await sourced(file, context);
  if (bytes.byteLength > context.maxFileSize) throw fileRefused({ refusal: FileRefusal.TooLarge });
  const sha256 = sha256Of(bytes);
  if (file.sha256 !== undefined && file.sha256 !== sha256)
    throw fileUnavailable({ reason: FileUnavailableReason.DigestMismatch });
  const mediaType = mediaTypeEssenceOf(file.mediaType);
  if (!isOfMediaType(mediaType, bytes))
    throw fileRefused({ refusal: FileRefusal.MediaTypeMismatch });
  return {
    mediaType,
    ...(file.filename === undefined ? {} : { filename: file.filename }),
    bytes,
    sha256,
  };
}
