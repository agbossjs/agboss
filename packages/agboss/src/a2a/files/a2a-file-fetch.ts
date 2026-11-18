import type { A2AError } from "@a2a-js/sdk/errors";
import type { Clock } from "../../infrastructure/clock.js";
import type { Bytes, Milliseconds } from "../../units/index.js";
import { invalidParams } from "../server/a2a-wire-errors.js";
import type { FileFetchSlots } from "./a2a-file-slots.js";
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
  /** The listener's slots (#1256): the fetch waits for one, within `timeout`; none: unbounded. */
  readonly slots?: FileFetchSlots;
  /** Whose fetch it is, for the slots' per-caller share (tenant and owner). */
  readonly tenant?: string;
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

const TOO_LARGE = "a2a.file-too-large";

/**
 * The body, at most `maxBytes`; the read stopped at the first byte past it. A body that fails
 * while it is read (the peer resets it, #1139) is `a2a.file-fetch-failed`, as a failed request is.
 */
async function boundedBodyOf(response: FileHttpResponse, maxBytes: Bytes): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        response.cancel(TOO_LARGE);
        throw refused(TOO_LARGE, "a file is larger than this agent takes");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (size > maxBytes) throw error;
    throw refused("a2a.file-fetch-failed", "the file could not be fetched");
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
      // a Location no URL can be made of (with or without this one as its base) is a url that is none
      const next = URL.canParse(response.location, url.href)
        ? new URL(response.location, url).href
        : response.location;
      url = allowedUrlOf(next, fetch.allowedOrigins, true);
      continue;
    }
    if (response.status < 200 || response.status > 299) {
      response.cancel();
      throw refused("a2a.file-fetch-failed", "the file could not be fetched");
    }
    return boundedBodyOf(response, fetch.maxBytes);
  }
}

/** The refusal of a fetch the deadline or the request's end cut. */
const notInTime = (): A2AError =>
  refused("a2a.file-fetch-failed", "the file could not be fetched in time");

/**
 * The bytes of a file by `url`, fetched as described above. The deadline and the request's end
 * settle the fetch themselves (#916): the fetch is raced against them and the signal then aborts
 * whatever is still open, so a transport that never answers — and ignores the signal — cannot hold
 * it past the timeout. With `slots` (#1256) the wait for a slot is part of that time.
 */
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
  const ended = new Promise<never>((_, reject) => {
    const settle = (): void => {
      reject(notInTime());
    };
    if (signal.aborted) settle();
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent: an abort fires once, and `settle` only rejects the promise, once
    signal.addEventListener("abort", settle, { once: true });
  });
  const fetched =
    fetch.slots?.run(
      signal,
      () => bodyAt(fetch, signal),
      () => refused("a2a.file-fetch-busy", "the agent is fetching too many files now"),
      // Stryker disable next-line StringLiteral: the key of a fetch with no tenant — any constant names the one shared caller
      fetch.tenant ?? "",
    ) ?? bodyAt(fetch, signal);
  try {
    return await Promise.race([fetched, ended]);
  } catch (error) {
    if (signal.aborted) throw notInTime();
    throw error;
  } finally {
    done.abort();
  }
}
