import { createHash } from "node:crypto";
import type { ReadableStream as WebStream } from "node:stream/web";
import { AGBossError } from "../../core/errors.js";
import { kilobytes, type Bytes, type Milliseconds } from "../../units/index.js";
import { FilePayloadSource, fileSourceOf } from "../../dto/standard/file.js";
import { fileUnavailable, FileUnavailableReason } from "../../files/file-errors.js";
import type { FileDto } from "../../dto/standard/file.js";
import { systemClock, type Clock } from "../../infrastructure/clock.js";
import type { FileFetchSlots } from "../files/a2a-file-slots.js";

export type { FileDto };

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
  /** The client's pool of downloads (#1316): none, no bound but `maxSize`. */
  readonly slots?: FileFetchSlots;
  /** How long a download may take, the wait for a slot included (the `@FilePolicy`'s `fetchTimeout`). */
  readonly timeout?: Milliseconds;
  /** The clock the timeout runs on (the client's, so a test's moves it). */
  readonly clock?: Pick<Clock, "sleep">;
}

const unavailable = (reason: FileUnavailableReason) => fileUnavailable({ reason });

/** The body of a response, at most `max` bytes: the read cancelled at the first byte past it. */
async function boundedBodyOf(response: Response, max: number): Promise<Uint8Array> {
  // the fetch's own web stream (a test's fetcher too): leaving the loop cancels it
  const body = response.body as WebStream<Uint8Array> | null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.byteLength;
    if (size > max) throw unavailable(FileUnavailableReason.TooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The signal a download runs under: the caller's, the policy's timeout (on the clock), and `stop`. */
function signalOf(download: A2ADownload, stop: AbortSignal): AbortSignal | undefined {
  if (download.timeout === undefined) return download.signal;
  // no clock given: the system's, so a set timeout is never skipped
  const clock = download.clock ?? systemClock;
  const timed = new AbortController();
  void clock.sleep(download.timeout, stop).then(
    () => {
      if (!stop.aborted)
        timed.abort(new Error("the download took longer than the policy's fetchTimeout"));
    },
    () => undefined,
  );
  return download.signal === undefined
    ? timed.signal
    : AbortSignal.any([download.signal, timed.signal]);
}

/** A file by `url`, fetched in the client's pool; any failure but the client's own refusals is `DownloadFailed`. */
async function fetchedOf(url: string, download: A2ADownload, max: number): Promise<Uint8Array> {
  const stop = new AbortController();
  const signal = signalOf(download, stop.signal);
  const work = () => fetchedBody(url, download, max, signal);
  try {
    if (download.slots === undefined) return await work();
    // a full pool fails at once, as on every path (#1316): FileError.Unavailable, FetchBusy
    return await download.slots.run(
      signal ?? stop.signal,
      work,
      () => unavailable(FileUnavailableReason.FetchBusy),
      { tenant: CLIENT_TENANT, owner: undefined },
    );
  } finally {
    stop.abort();
  }
}

/** The pool's one tenant: a standalone client has no tenant of its own. */
const CLIENT_TENANT = JSON.stringify(["a2a-client"]);

async function fetchedBody(
  url: string,
  download: A2ADownload,
  max: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await download.fetcher(url, signal === undefined ? {} : { signal });
  } catch (error) {
    // an origin refused by the client's policy is said as it is (`A2AError.OriginRefused`)
    if (error instanceof AGBossError) throw error;
    throw unavailable(FileUnavailableReason.DownloadFailed);
  }
  if (!response.ok) throw unavailable(FileUnavailableReason.DownloadFailed);
  return boundedBodyOf(response, max);
}

/** An inline file is checked against its digest, so one with none is refused; only a file by url may come without. */
function requireDigest(file: FileDto): void {
  if (file.sha256 === undefined && fileSourceOf(file) !== FilePayloadSource.Url)
    throw unavailable(FileUnavailableReason.DigestMissing);
}

/** A received file's bytes, as `A2AClient.downloadFile` says. */
export async function downloadedFile(file: FileDto, download: A2ADownload): Promise<Uint8Array> {
  const max = download.maxSize ?? DEFAULT_MAX_SIZE;
  // a stored descriptor is another application's own: never a file the client received
  if (fileSourceOf(file) === FilePayloadSource.Stored)
    throw unavailable(FileUnavailableReason.NotFound);
  requireDigest(file);
  const bytes =
    fileSourceOf(file) === FilePayloadSource.Url
      ? await fetchedOf(file.url ?? "", download, max)
      : new Uint8Array(Buffer.from(file.inline ?? "", "base64"));
  if (bytes.byteLength > max) throw unavailable(FileUnavailableReason.TooLarge);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (file.sha256 !== undefined && file.sha256 !== digest)
    throw unavailable(FileUnavailableReason.DigestMismatch);
  return bytes;
}
