// #859 — an S3-compatible store in process, for `S3A2AFileRepository`'s tests: path-style objects
// of one bucket, `If-None-Match: *` puts, user metadata, `ListObjectsV2` paged by two (from
// `start-after`, recording each listing's keys) — and every
// request's Signature Version 4 recomputed and checked, so an unsigned or mis-signed call fails.
import { authorizationOf, sha256Hex } from "../../../src/infrastructure/s3/s3-signing.js";

export const S3_ENDPOINT = "http://s3.test";
export const S3_BUCKET = "files";
export const S3_REGION = "eu-test-1";
export const S3_KEYS = { accessKeyId: "AKIDTEST", secretAccessKey: "secret-test" } as const;

interface StoredObject {
  readonly body: Uint8Array;
  readonly metadata: Readonly<Record<string, string>>;
}

const PAGE = 2;

const urlOfInput = (input: Parameters<typeof fetch>[0]): URL =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** One bucket's objects, shared by every store built on its `fetcher`. */
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/** A GET: the object, or its first bytes for a `Range: bytes=0-N`. */
function getOf(found: StoredObject | undefined, headers: Headers): Response {
  if (found === undefined) return new Response("", { status: 404 });
  const range = /^bytes=0-(\d+)$/.exec(headers.get("range") ?? "");
  if (range === null) return new Response(Buffer.from(found.body), { status: 200 });
  const end = Math.min(Number(range[1]) + 1, found.body.byteLength);
  return new Response(Buffer.from(found.body.subarray(0, end)), { status: 206 });
}

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: string[] = [];
  /** Every key a listing answered with, in order. */
  readonly listed: string[] = [];

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = urlOfInput(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : new Uint8Array();
    this.requests.push(`${method} ${url.pathname}`);
    if (!this.#isSigned(method, url, headers, body)) return new Response("", { status: 403 });
    const key = decodeURIComponent(url.pathname.slice(`/${S3_BUCKET}/`.length));
    if (url.searchParams.get("list-type") === "2") return this.#list(url);
    return this.#object(method, key, headers, body);
  };

  #isSigned(method: string, url: URL, headers: Headers, body: Uint8Array): boolean {
    const given = headers.get("authorization") ?? "";
    const signed = /SignedHeaders=([^,]+)/.exec(given)?.[1]?.split(";") ?? [];
    const values = Object.fromEntries(
      signed.map((name) => [name, name === "host" ? url.host : (headers.get(name) ?? "")]),
    );
    const payloadHash = sha256Hex(body);
    if (headers.get("x-amz-content-sha256") !== payloadHash) return false;
    const amzDate = headers.get("x-amz-date") ?? "";
    const expected = authorizationOf(
      { method, url, headers: values, payloadHash, region: S3_REGION, amzDate },
      S3_KEYS,
    );
    return given === expected;
  }

  #object(method: string, key: string, headers: Headers, body: Uint8Array): Response {
    // #904: as MinIO and S3 refuse it — a segment above 255 bytes, a key above 1024
    if (bytesOf(key) > 1024 || key.split("/").some((segment) => bytesOf(segment) > 255))
      return new Response("<Error><Code>XMinioInvalidObjectName</Code></Error>", { status: 400 });
    const found = this.objects.get(key);
    switch (method) {
      case "PUT":
        return this.#put(key, headers, body, found);
      case "DELETE":
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return getOf(found, headers);
    }
  }

  #put(key: string, headers: Headers, body: Uint8Array, found: StoredObject | undefined): Response {
    if (headers.get("if-none-match") === "*" && found !== undefined)
      return new Response("", { status: 412 });
    const metadata: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (name.startsWith("x-amz-meta-")) metadata[name] = value;
    });
    // as S3 and MinIO refuse them: user metadata above 2 KB
    const size = Object.entries(metadata).reduce(
      (total, [name, value]) => total + bytesOf(name.slice("x-amz-meta-".length)) + bytesOf(value),
      0,
    );
    if (size > 2048)
      return new Response("<Error><Code>MetadataTooLarge</Code></Error>", { status: 400 });
    this.objects.set(key, { body, metadata });
    return new Response("", { status: 200 });
  }

  #list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const after =
      url.searchParams.get("continuation-token") ?? url.searchParams.get("start-after") ?? "";
    const max = Number(url.searchParams.get("max-keys") ?? PAGE);
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && key > after)
      .sort();
    const page = keys.slice(0, Math.min(max, PAGE));
    this.listed.push(...page);
    const isTruncated = keys.length > page.length;
    const contents = page.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("");
    const next = isTruncated
      ? `<NextContinuationToken>${page.at(-1) ?? ""}</NextContinuationToken>`
      : "";
    const xml = `<ListBucketResult><IsTruncated>${String(isTruncated)}</IsTruncated>${contents}${next}</ListBucketResult>`;
    return new Response(xml, { status: 200 });
  }
}
