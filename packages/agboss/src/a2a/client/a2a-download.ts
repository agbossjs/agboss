import { createHash } from "node:crypto";
import type { ReadableStream as WebStream } from "node:stream/web";
import { AGBossError } from "../../core/errors.js";
import { kilobytes, type Bytes } from "../../units/index.js";
import { A2AFileSource, fileSourceOf } from "../files/a2a-file.dto.js";
import { A2AFileUnavailableError, A2AFileUnavailableReason } from "../files/a2a-file-errors.js";
import type { A2AReceivedFile } from "./a2a-client-files.js";

export type { A2AReceivedFile };

/** `client.downloadFile(file, { maxSize?, signal? })` (#859). */
export interface A2ADownloadOptions {
  /** The most bytes read: one more stops the download (`kilobytes(10240)` by default). */
  readonly maxSize?: Bytes;
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_SIZE = kilobytes(10240);

/** What a download goes through: the client's own fetch (its origins, its headers). */
export interface A2ADownload extends A2ADownloadOptions {
  readonly fetcher: typeof fetch;
}

const unavailable = (reason: A2AFileUnavailableReason) => new A2AFileUnavailableError(reason);

/** The body of a response, at most `max` bytes: the read cancelled at the first byte past it. */
async function boundedBodyOf(response: Response, max: number): Promise<Uint8Array> {
  // the fetch's own web stream (a test's fetcher too): leaving the loop cancels it
  const body = response.body as WebStream<Uint8Array> | null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.byteLength;
    if (size > max) throw unavailable(A2AFileUnavailableReason.TooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A file by `url`, fetched; any failure but the client's own refusals is `DownloadFailed`. */
async function fetchedOf(url: string, download: A2ADownload, max: number): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await download.fetcher(
      url,
      download.signal === undefined ? {} : { signal: download.signal },
    );
  } catch (error) {
    // an origin refused by the client's policy is said as it is (`A2AOriginError`)
    if (error instanceof AGBossError) throw error;
    throw unavailable(A2AFileUnavailableReason.DownloadFailed);
  }
  if (!response.ok) throw unavailable(A2AFileUnavailableReason.DownloadFailed);
  return boundedBodyOf(response, max);
}

/** A received file's bytes, as `A2AClient.downloadFile` says. */
export async function downloadedFile(
  file: A2AReceivedFile,
  download: A2ADownload,
): Promise<Uint8Array> {
  const max = download.maxSize ?? DEFAULT_MAX_SIZE;
  // a stored descriptor is another application's own: never a file the client received
  if (fileSourceOf(file) === A2AFileSource.Stored)
    throw unavailable(A2AFileUnavailableReason.NotFound);
  const bytes =
    fileSourceOf(file) === A2AFileSource.Url
      ? await fetchedOf(file.url ?? "", download, max)
      : new Uint8Array(Buffer.from(file.inline ?? "", "base64"));
  if (bytes.byteLength > max) throw unavailable(A2AFileUnavailableReason.TooLarge);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (file.sha256 !== undefined && file.sha256 !== digest)
    throw unavailable(A2AFileUnavailableReason.DigestMismatch);
  return bytes;
}
