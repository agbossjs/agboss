import type { Clock } from "../clock.js";
import { amzDateOf, authorizationOf, sha256Hex, type S3Credentials } from "./s3-signing.js";

/**
 * The few S3 calls a file store makes (#859), on plain `fetch` with Signature Version 4: `PUT` (only
 * when absent: `If-None-Match: *`), `GET`, `HEAD`, `DELETE` and `ListObjectsV2`, path-style on an
 * endpoint given (MinIO, a compatible store), virtual-hosted on AWS otherwise. A failure is
 * `S3RequestError` with its status, never the body (it may name the bucket's internals).
 */

/** Where the bucket is and who signs. */
export interface S3Location {
  readonly bucket: string;
  readonly region: string;
  /** An S3-compatible endpoint (`https://minio.internal:9000`); none: AWS. */
  readonly endpoint?: string | undefined;
  readonly credentials: S3Credentials;
}

/** An S3 call that did not succeed: its operation and HTTP status. */
export class S3RequestError extends Error {
  override name = "S3RequestError";

  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`S3 ${operation} failed: HTTP ${String(status)}`);
  }
}

const EMPTY_HASH = sha256Hex("");

/** `&amp;` and its kin back to text (keys in a listing are XML). */
const unescaped = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export class S3Client {
  constructor(
    private readonly location: S3Location,
    private readonly clock: Pick<Clock, "now">,
    private readonly fetcher: typeof fetch,
  ) {}

  /** The URL of a key (each segment as it is: the store's keys are URL-safe). */
  #urlOf(key: string, query: Readonly<Record<string, string>> = {}): URL {
    const { bucket, region, endpoint } = this.location;
    const base =
      endpoint === undefined
        ? `https://${bucket}.s3.${region}.amazonaws.com`
        : `${endpoint.replace(/\/+$/, "")}/${bucket}`;
    // the bucket itself (a listing) without a trailing slash, as path-style wants it
    const url = new URL(key === "" ? base : `${base}/${key}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  async #send(
    method: string,
    url: URL,
    more: { readonly headers?: Record<string, string>; readonly body?: Uint8Array } = {},
  ): Promise<Response> {
    const payloadHash = more.body === undefined ? EMPTY_HASH : sha256Hex(more.body);
    const amzDate = amzDateOf(this.clock.now());
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...more.headers,
    };
    const request = { method, url, headers, payloadHash, region: this.location.region, amzDate };
    const authorization = authorizationOf(request, this.location.credentials);
    // the fetch sets `host` itself
    const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "host"));
    return this.fetcher(url, {
      method,
      headers: { ...sent, authorization },
      ...(more.body === undefined ? {} : { body: Buffer.from(more.body) }),
    });
  }

  /** Writes an object unless one is there: `false` when one was (`412`). */
  async putIfAbsent(
    key: string,
    body: Uint8Array,
    metadata: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const headers = Object.fromEntries(
      Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name}`, value]),
    );
    const response = await this.#send("PUT", this.#urlOf(key), {
      headers: { ...headers, "if-none-match": "*", "content-type": "application/octet-stream" },
      body,
    });
    if (response.status === 412) return false;
    if (!response.ok) throw new S3RequestError("PUT", response.status);
    return true;
  }

  /** An object's bytes — its first `firstBytes` only, when given; `undefined` when there is none. */
  async get(key: string, firstBytes?: number): Promise<Uint8Array | undefined> {
    const range = firstBytes === undefined ? {} : { range: `bytes=0-${String(firstBytes - 1)}` };
    const response = await this.#send("GET", this.#urlOf(key), { headers: range });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new S3RequestError("GET", response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.#send("DELETE", this.#urlOf(key));
    if (!response.ok && response.status !== 404)
      throw new S3RequestError("DELETE", response.status);
  }

  /** Every key under a prefix (after `startAfter`), page by page, in the store's (lexicographic) order. */
  async *keys(prefix: string, startAfter?: string): AsyncGenerator<string> {
    let token: string | undefined;
    do {
      const query = {
        "list-type": "2",
        prefix,
        ...(startAfter === undefined ? {} : { "start-after": startAfter }),
        ...(token === undefined ? {} : { "continuation-token": token }),
      };
      const response = await this.#send("GET", this.#urlOf("", query));
      if (!response.ok) throw new S3RequestError("LIST", response.status);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) yield unescaped(match[1] ?? "");
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
      token =
        xml.includes("<IsTruncated>true</IsTruncated>") && next !== undefined
          ? unescaped(next)
          : undefined;
    } while (token !== undefined);
  }

  /** One fast round trip: a listing of at most one key. */
  async ping(): Promise<void> {
    const response = await this.#send(
      "GET",
      this.#urlOf("", { "list-type": "2", "max-keys": "1" }),
    );
    if (!response.ok) throw new S3RequestError("LIST", response.status);
  }
}
