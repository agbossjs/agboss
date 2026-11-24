import type { KeyObject } from "node:crypto";
import { millisecondsOf } from "./mesh-durations.js";
import type { ReadEnvelope } from "./mesh-envelope-codec.js";
import { isSignedBy } from "./mesh-jws.js";

/**
 * A signed envelope's checks on the receiver (#398 PR 2): the signature of its issuer's key, and
 * its replay window — `issuedAt` + `expiresIn` on the receiver's `Clock`, with the mesh's `maxClockSkew`
 * for the clocks' skew and its `envelopeTtl` as the longest lifetime it accepts. A failed check refuses the request (`401 { code }`): a forged or replayed
 * envelope never runs. The body check (`bodyHash`) comes once the body is read.
 */

/** The wire codes of a refused envelope. */
export enum MeshRefusalCode {
  /** Its signature is not its issuer's. */
  SignatureInvalid = "mesh.signature-invalid",
  /** Past `issuedAt` + `expiresIn`, issued in the future, or without them. */
  EnvelopeExpired = "mesh.envelope-expired",
  /** Its `bodyHash` is not the request's body's. */
  BodyMismatch = "mesh.body-mismatch",
  /** A trusted request of the same idempotency key still runs. */
  RequestInProgress = "mesh.request-in-progress",
  /** Its `audience` is another application (#398 PR 3): it was meant for someone else. */
  AudienceMismatch = "mesh.audience-mismatch",
  /**
   * A signed envelope that names no `audience` (#809 security): it could be replayed to any
   * application as its issuer's signed word — refused, whoever holds its key.
   */
  AudienceMissing = "mesh.audience-missing",
  /** The request is signed by no known peer's key, or by a peer that is not listed (#1320). */
  PeerUnknown = "mesh.peer-unknown",
  /** A mesh endpoint that admits only peers got no signed `X-AGBoss-Mesh` header (#1320). */
  SignatureMissing = "mesh.signature-missing",
  /** Its header was signed for another method, path or body than this request's (#1320). */
  RequestMismatch = "mesh.request-mismatch",
  /** The verified peer may not call this endpoint (`allowEndpoints`, #1320). */
  EndpointForbidden = "mesh.endpoint-forbidden",
  /** The same signed request was admitted before (`X-AGBoss-Mesh` `jti`, #1320): a replay. */
  Replayed = "mesh.replayed",
  /** The store that remembers the admitted requests did not answer: nothing is admitted (#1320). */
  ReplayCheckUnavailable = "mesh.replay-check-unavailable",
  /** The peer's signed tenant is not the request's envelope's, or none is signed where one is needed (#1320). */
  TenantMismatch = "mesh.tenant-mismatch",
}

/** What the caller reads of each refusal. */
export const MESH_REFUSAL_TEXT: Readonly<Record<MeshRefusalCode, string>> = {
  [MeshRefusalCode.SignatureInvalid]: "the mesh envelope's signature is not its issuer's",
  [MeshRefusalCode.EnvelopeExpired]: "the mesh envelope has expired or is not yet valid",
  [MeshRefusalCode.BodyMismatch]: "the mesh envelope was signed for another request body",
  [MeshRefusalCode.RequestInProgress]: "a request with this idempotency key is still running",
  [MeshRefusalCode.AudienceMismatch]: "the mesh envelope is addressed to another application",
  [MeshRefusalCode.AudienceMissing]: "the signed mesh envelope is addressed to no application",
  [MeshRefusalCode.PeerUnknown]: "the mesh request is signed by no peer of this application",
  [MeshRefusalCode.SignatureMissing]: "this endpoint admits only signed mesh requests",
  [MeshRefusalCode.RequestMismatch]: "the mesh signature was made for another request",
  [MeshRefusalCode.EndpointForbidden]: "the mesh peer may not call this endpoint",
  [MeshRefusalCode.Replayed]: "this signed mesh request was already admitted",
  [MeshRefusalCode.ReplayCheckUnavailable]: "the mesh could not check the request is new",
  [MeshRefusalCode.TenantMismatch]: "the mesh peer's tenant does not match the request",
};

/**
 * Whether an envelope is meant for `application` (#398 PR 3): its `audience`, when it names one,
 * must be the receiver's name — signed or not (a claim that only restricts). A signed envelope
 * must name one (#809 security, fail closed): without it, it is `mesh.audience-missing`.
 */
export const audienceRefusalOf = (
  read: ReadEnvelope | undefined,
  application: string,
): MeshRefusalCode | undefined => {
  if (read === undefined) return undefined;
  const audience = read.envelope.audience;
  if (audience === undefined) {
    return read.signed === undefined ? undefined : MeshRefusalCode.AudienceMissing;
  }
  return audience === application ? undefined : MeshRefusalCode.AudienceMismatch;
};

/** How far a signed date may be from the receiver's clock, and the longest lifetime it trusts (ms). */
export interface SignatureWindow {
  readonly maxClockSkew: number;
  readonly envelopeTtl: number;
}

/**
 * Why a signature's date is refused at `now`: not yet valid (issued after `now` + the skew), or
 * expired — its lifetime, capped by the receiver's `envelopeTtl`, plus the skew, is over. A date or
 * lifetime that is no number is refused too.
 */
export function windowRefusalOf(
  issuedAtText: string | undefined,
  expiresIn: string | undefined,
  now: Date,
  window: SignatureWindow,
): MeshRefusalCode | undefined {
  // Stryker disable next-line StringLiteral: equivalent: an envelope with no date is no date either way: `Date.parse` reads both texts as NaN
  const issuedAt = Date.parse(issuedAtText ?? "");
  const claimed = millisecondsOf(expiresIn);
  if (Number.isNaN(issuedAt) || claimed === undefined) return MeshRefusalCode.EnvelopeExpired;
  const lifetime = Math.min(claimed, window.envelopeTtl);
  const at = now.getTime();
  const isOutside =
    at < issuedAt - window.maxClockSkew || at > issuedAt + lifetime + window.maxClockSkew;
  return isOutside ? MeshRefusalCode.EnvelopeExpired : undefined;
}

/**
 * Why a signed envelope is refused at `now`; `undefined` when it holds. Any of the issuer's `keys`
 * verifies it (a rotation lists the old and the new one) — no other key does.
 */
export function signatureRefusalOf(
  read: ReadEnvelope,
  keys: readonly KeyObject[],
  now: Date,
  window: SignatureWindow,
): MeshRefusalCode | undefined {
  const { signed } = read;
  if (signed === undefined || !keys.some((key) => isSignedBy(signed, key)))
    return MeshRefusalCode.SignatureInvalid;
  return windowRefusalOf(read.envelope.issuedAt, read.envelope.expiresIn, now, window);
}
