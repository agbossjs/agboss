import type { A2AError } from "@a2a-js/sdk/errors";
import type { Clock } from "../../infrastructure/clock.js";
import type { Bytes, Milliseconds } from "../../units/index.js";
import { invalidParams } from "../server/a2a-wire-errors.js";
import {
  FileAddressDeniedError,
  type FileHttpResponse,
  type FileTransport,
} from "./a2a-file-transport.js";

/**
 * The fetch of a file by `url` at a message's admission (#859, SSRF-safe): `GET` only, from an
 * `https:` origin in `allowedFileOrigins` (none listed: no file by reference), redirects followed by
 * hand — at most `MAX_REDIRECTS`, each target's origin checked the same —, never a url with userinfo
 * (#904: on a redirect neither), never a private address
 * (the transport's lookup), the body read only up to `maxBytes` (one more byte aborts it, nothing
 * buffered past it), the whole of it bound to the request's end and the fetch timeout. Every
 * refusal is `-32602` with a stable code and nothing of the caller's URL.
 */

export const MAX_REDIRECTS = 3;

/** What a fetch is bound by. */
export interface FileFetch {
  readonly url: string;
  readonly allowedOrigins: readonly string[];
  readonly maxBytes: Bytes;
  readonly transport: FileTransport;
  readonly clock: Pick<Clock, "sleep">;
  readonly timeout: Milliseconds;
  /** The request's end: its connection closed. */
  readonly signal: AbortSignal;
}

const refused = (code: string, message: string): A2AError => invalidParams(code, message);

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The URL of a file, on an allowed origin; refused otherwise. */
function allowedUrlOf(text: string, allowed: readonly string[], isRedirect: boolean): URL {
  if (!URL.canParse(text)) throw refused("a2a.file-url-invalid", "the file's url is not a URL");
  const url = new URL(text);
  // #904: never a user or a password — Node would send them as `Authorization: Basic`
  if (url.username !== "" || url.password !== "")
    throw refused("a2a.file-origin-denied", "the file's url carries a user or a password");
  if (url.protocol === "https:" && allowed.includes(url.origin)) return url;
  if (isRedirect)
    throw refused("a2a.file-origin-denied", "the file's url redirects to an origin not allowed");
  if (allowed.length === 0)
    throw refused("a2a.file-url-not-allowed", "this agent takes no file by url");
  throw refused("a2a.file-origin-denied", "the file's url is on an origin not allowed");
}

/** The body, at most `maxBytes`; the read stopped at the first byte past it. */
async function boundedBodyOf(response: FileHttpResponse, maxBytes: Bytes): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      response.cancel();
      throw refused("a2a.file-too-large", "a file is larger than this agent takes");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One `GET`, a network failure or a denied address as its refusal. */
async function responseOf(fetch: FileFetch, url: URL, signal: AbortSignal) {
  try {
    return await fetch.transport(url, signal);
  } catch (error) {
    if (error instanceof FileAddressDeniedError)
      throw refused("a2a.file-address-denied", "the file's host is an address never fetched from");
    throw refused("a2a.file-fetch-failed", "the file could not be fetched");
  }
}

/** Follows the URL to the file's body: redirects checked hop by hop. */
async function bodyAt(fetch: FileFetch, signal: AbortSignal): Promise<Uint8Array> {
  let url = allowedUrlOf(fetch.url, fetch.allowedOrigins, false);
  for (let hop = 0; ; hop += 1) {
    const response = await responseOf(fetch, url, signal);
    if (REDIRECTS.has(response.status)) {
      response.cancel();
      if (hop === MAX_REDIRECTS || response.location === undefined)
        throw refused("a2a.file-fetch-failed", "the file's url redirects too often");
      const next = URL.canParse(response.location, url.href)
        ? new URL(response.location, url)
        : undefined;
      url = allowedUrlOf(next?.href ?? "", fetch.allowedOrigins, true);
      continue;
    }
    if (response.status < 200 || response.status > 299) {
      response.cancel();
      throw refused("a2a.file-fetch-failed", "the file could not be fetched");
    }
    return boundedBodyOf(response, fetch.maxBytes);
  }
}

/** The bytes of a file by `url`, fetched as described above. */
export async function fetchedFile(fetch: FileFetch): Promise<Uint8Array> {
  const timedOut = new AbortController();
  const done = new AbortController();
  void fetch.clock.sleep(fetch.timeout, done.signal).then(
    () => {
      timedOut.abort();
    },
    () => undefined, // the fetch ended first
  );
  const signal = AbortSignal.any([fetch.signal, timedOut.signal]);
  try {
    return await bodyAt(fetch, signal);
  } catch (error) {
    if (signal.aborted)
      throw refused("a2a.file-fetch-failed", "the file could not be fetched in time");
    throw error;
  } finally {
    done.abort();
  }
}
