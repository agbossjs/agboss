import { sign, verify, type KeyObject } from "node:crypto";

/**
 * Compact JWS (RFC 7515) for the mesh (#398): `base64url(header).base64url(payload).signature` —
 * `EdDSA` (Ed25519) with a key, unsecured (`alg: "none"`, empty signature) without. Its readers
 * take a value they can read or nothing: too long, not three parts, another `alg`, JSON that does
 * not parse.
 */

/** A JWS read: its payload, and — when signed — what its signature covers. */
export interface ReadJws {
  readonly payload: unknown;
  /** `EdDSA` signed; `undefined` for `alg: "none"`. */
  readonly signed?: JwsSignature;
}

/** A signature and the text it covers (`header.payload`). */
export interface JwsSignature {
  readonly input: string;
  readonly signature: Buffer;
}

/** The longest value read: a chain of 64 hops fits many times over. */
const MAX_LENGTH = 16_384;

const encodePart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodePart = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

/** `payload` as a compact JWS of type `typ`: signed with `key` (Ed25519), else unsecured. */
export function encodeJws(typ: string, payload: unknown, key?: KeyObject): string {
  const header = encodePart({ alg: key === undefined ? "none" : "EdDSA", typ });
  const input = `${header}.${encodePart(payload)}`;
  if (key === undefined) return `${input}.`;
  return `${input}.${sign(null, Buffer.from(input, "utf8"), key).toString("base64url")}`;
}

const algOf = (header: unknown): unknown =>
  typeof header === "object" && header !== null ? Reflect.get(header, "alg") : undefined;

/** The three parts of a compact JWS; `undefined` for anything else. */
function partsOf(value: unknown): readonly [string, string, string] | undefined {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return undefined;
  const parts = value.split(".");
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || header === undefined || payload === undefined) return undefined;
  return signature === undefined ? undefined : [header, payload, signature];
}

/** A compact JWS of `alg: "none"` or `EdDSA`; `undefined` for anything else. */
export function readJws(value: unknown): ReadJws | undefined {
  const parts = partsOf(value);
  if (parts === undefined) return undefined;
  const [header, payload, signature] = parts;
  const alg = algOf(decodePart(header));
  const decoded = decodePart(payload);
  if (decoded === undefined) return undefined;
  if (alg === "none" && signature === "") return { payload: decoded };
  if (alg !== "EdDSA" || signature === "") return undefined;
  const signed = { input: `${header}.${payload}`, signature: Buffer.from(signature, "base64url") };
  return { payload: decoded, signed };
}

/** Whether `signed` is a valid Ed25519 signature of `key`'s pair. */
export function isSignedBy(signed: JwsSignature, key: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(signed.input, "utf8"), key, signed.signature);
  } catch {
    return false;
  }
}
