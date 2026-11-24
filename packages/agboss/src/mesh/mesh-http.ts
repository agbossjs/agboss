import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { z } from "zod";
import { isoDurationOf } from "./mesh-durations.js";
import { encodeJws, isSignedBy, readJws } from "./mesh-jws.js";
import type { MeshSettings } from "./mesh-settings.js";
import { MeshRefusalCode, windowRefusalOf } from "./mesh-verification.js";

/**
 * The HTTP request signature of the mesh (#1320): `X-AGBoss-Mesh`, a compact JWS (`EdDSA`) of type
 * `agboss-mesh-http` whose claims bind one request — `{ issuer, audience, origin, jti, method, path, bodyHash,
 * issuedAt, expiresIn, tenantId? }`, `path` with its query string, `bodyHash` of the bytes sent. Every
 * HTTP request of an AGBoss client to another application carries one, so a `Strict` receiver admits a
 * peer's request without an `@HttpAuthenticator`. The receiver verifies the signature first — with the
 * keys of the issuer it names, never trusting anything else of the claims before it holds — then the
 * audience, the date window and that the claims are this request's; every failure is one code and
 * never a text of the peer.
 */

/** The header that carries it. */
export const MESH_HTTP_HEADER = "X-AGBoss-Mesh";

const TYP = "agboss-mesh-http";
const ID = z.string().min(1).max(500);

const ClaimsSchema = z.object({
  issuer: ID,
  audience: ID,
  /** The origin the request is sent to: a signature for peer A's URL is no signature for peer B's. */
  origin: ID,
  /** A random 128-bit id: the receiver admits each `(issuer, jti)` once. */
  jti: ID,
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(8192),
  bodyHash: ID,
  issuedAt: z.iso.datetime(),
  expiresIn: ID,
  tenantId: ID.optional(),
});

/** What one signed request claims. */
export type MeshHttpClaims = z.infer<typeof ClaimsSchema>;

/** The path of a URL with its query string (`/tasks?pageSize=5`). */
const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** `sha256:<hex>` of the bytes of a request's body (empty for a request with none). */
export const httpBodyHashOf = (body: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

/** What a client signs: the request it is about to make, to which application, for which tenant. */
export interface MeshHttpRequest {
  readonly audience: string;
  readonly method: string;
  /** The absolute URL it is sent to: its origin is signed, its path and query too. */
  readonly url: string;
  readonly body: string | Uint8Array;
  /** The caller's tenant, signed when the peer trusts it (`propagateTenant`). */
  readonly tenantId?: string | undefined;
}

/**
 * The header's value for `request`: signed with the application's key and named by its own name, on
 * its own clock — whether or not a step is running (a handshake at start, a `GetTask` from a script);
 * `undefined` for an application with no `signingKey` (nothing is signed).
 */
export function signMeshHttp(
  settings: Pick<MeshSettings, "application" | "keys" | "clock" | "envelopeTtl">,
  request: MeshHttpRequest,
): string | undefined {
  const key = settings.keys.signingKey;
  if (key === undefined) return undefined;
  const claims: MeshHttpClaims = {
    issuer: settings.application,
    audience: request.audience,
    origin: new URL(request.url).origin,
    jti: randomBytes(16).toString("base64url"),
    method: request.method.toUpperCase(),
    path: pathOf(request.url),
    bodyHash: httpBodyHashOf(request.body),
    issuedAt: settings.clock.now().toISOString(),
    expiresIn: isoDurationOf(settings.envelopeTtl),
    ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
  };
  return encodeJws(TYP, claims, key);
}

/** What the receiver knows of the request it checks the header against. */
export interface ReceivedHttp {
  readonly header: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly body: string | Uint8Array;
  /** The origin this application is reached at, when it knows it (a listener's `publicUrl`): the header must name it. */
  readonly origin?: string | undefined;
}

/** A header that held: the peer that signed it and the tenant it signed, when it signed one. */
export interface VerifiedMeshHttp {
  readonly isVerified: true;
  readonly peer: string;
  readonly tenantId: string | undefined;
  /** The header's one-time id and when it was signed: what the receiver admits once. */
  readonly jti: string;
  /** When the peer dated the signature: the dedupe record lives from then (never earlier than now). */
  readonly issuedAt: Date;
}

/** A header that did not: the one code (`401`). */
export interface RefusedMeshHttp {
  readonly isVerified: false;
  readonly code: MeshRefusalCode;
}

export type MeshHttpVerdict = VerifiedMeshHttp | RefusedMeshHttp;

const refused = (code: MeshRefusalCode): RefusedMeshHttp => ({ isVerified: false, code });

/**
 * Checks the `X-AGBoss-Mesh` header of one received request. In order: it is a signed JWS of its
 * type, the issuer it names is a peer, one of the peer's keys verifies the signature — only then are
 * the claims read as true: this application is the audience, the date window holds
 * (`maxClockSkew`, a lifetime capped by `envelopeTtl`), and method, path and body are this request's.
 */
export function verifyMeshHttp(settings: MeshSettings, received: ReceivedHttp): MeshHttpVerdict {
  const jws = readJws(received.header);
  if (jws?.signed === undefined) return refused(MeshRefusalCode.SignatureInvalid);
  const parsed = ClaimsSchema.safeParse(jws.payload);
  if (!parsed.success) return refused(MeshRefusalCode.SignatureInvalid);
  const claims = parsed.data;
  const keys: readonly KeyObject[] = settings.keys.peers.get(claims.issuer) ?? [];
  if (keys.length === 0) return refused(MeshRefusalCode.PeerUnknown);
  const { signed } = jws;
  if (!keys.some((key) => isSignedBy(signed, key)))
    return refused(MeshRefusalCode.SignatureInvalid);
  // the signature holds: only now are the claims read as the peer's word
  const failure = claimRefusalOf(settings, claims, received);
  return failure === undefined
    ? {
        isVerified: true,
        peer: claims.issuer,
        tenantId: claims.tenantId,
        jti: claims.jti,
        issuedAt: new Date(claims.issuedAt),
      }
    : refused(failure);
}

/** Why the claims of a signed header are not this request's, at this receiver and now. */
function claimRefusalOf(
  settings: MeshSettings,
  claims: MeshHttpClaims,
  received: ReceivedHttp,
): MeshRefusalCode | undefined {
  if (claims.audience !== settings.application) return MeshRefusalCode.AudienceMismatch;
  if (received.origin !== undefined && claims.origin !== received.origin)
    return MeshRefusalCode.AudienceMismatch;
  const now = settings.clock.now();
  const expired = windowRefusalOf(claims.issuedAt, claims.expiresIn, now, settings);
  if (expired !== undefined) return expired;
  const isThisRequest =
    claims.method === received.method.toUpperCase() &&
    claims.path === received.path &&
    claims.bodyHash === httpBodyHashOf(received.body);
  return isThisRequest ? undefined : MeshRefusalCode.RequestMismatch;
}
