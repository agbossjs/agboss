import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for S3 (#859, `S3A2AFileRepository`): the `Authorization` header of one
 * request — the canonical request (method, path, sorted query, the signed headers, the payload's
 * SHA-256), the string to sign for its date, region and `s3`, and the key derived from the secret
 * for that day. Pure: the date, the keys and the request come in.
 */

/** The keys a request is signed with. */
export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** One request to sign. */
export interface S3SignedRequest {
  readonly method: string;
  readonly url: URL;
  /** Every header sent besides `authorization`, lower-case names; `host` among them. */
  readonly headers: Readonly<Record<string, string>>;
  /** The SHA-256 of the body, hex (`x-amz-content-sha256`). */
  readonly payloadHash: string;
  readonly region: string;
  /** `YYYYMMDDTHHMMSSZ` (`x-amz-date`). */
  readonly amzDate: string;
}

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters. */
export const uriEncode = (text: string): string =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20130524T000000Z` of a date. */
export const amzDateOf = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** The canonical query: each name and value encoded, sorted by name. */
function canonicalQueryOf(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([name, value]) => [uriEncode(name), uriEncode(value)] as const,
  );
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/** The `Authorization` header of a request. */
export function authorizationOf(request: S3SignedRequest, credentials: S3Credentials): string {
  const names = Object.keys(request.headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(request.headers[name] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonical = [
    request.method,
    request.url.pathname,
    canonicalQueryOf(request.url),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join("\n");
  const day = request.amzDate.slice(0, 8);
  const scope = `${day}/${request.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", request.amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = ["s3", "aws4_request"].reduce(
    (derived, part) => hmac(derived, part),
    hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), request.region),
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
