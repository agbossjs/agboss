import type { KeyObject } from "node:crypto";
import { CLOCK_TOLERANCE } from "./mesh-defaults.js";
import { millisecondsOf } from "./mesh-durations.js";
import type { ReadEnvelope } from "./mesh-envelope-codec.js";
import { isSignedBy } from "./mesh-jws.js";

/**
 * A signed envelope's checks on the receiver (#398 PR 2): the signature of its issuer's key, and
 * its replay window — `issuedAt` + `expiresIn` on the receiver's `Clock`, with `CLOCK_TOLERANCE`
 * for the clocks' skew. A failed check refuses the request (`401 { code }`): a forged or replayed
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
}

/** What the caller reads of each refusal. */
export const MESH_REFUSAL_TEXT: Readonly<Record<MeshRefusalCode, string>> = {
  [MeshRefusalCode.SignatureInvalid]: "the mesh envelope's signature is not its issuer's",
  [MeshRefusalCode.EnvelopeExpired]: "the mesh envelope has expired or is not yet valid",
  [MeshRefusalCode.BodyMismatch]: "the mesh envelope was signed for another request body",
  [MeshRefusalCode.RequestInProgress]: "a request with this idempotency key is still running",
  [MeshRefusalCode.AudienceMismatch]: "the mesh envelope is addressed to another application",
};

/**
 * Whether an envelope is meant for `application` (#398 PR 3): its `audience`, when it names one,
 * must be the receiver's name — signed or not (a claim that only restricts).
 */
export const audienceRefusalOf = (
  read: ReadEnvelope | undefined,
  application: string,
): MeshRefusalCode | undefined => {
  const audience = read?.envelope.audience;
  return audience === undefined || audience === application
    ? undefined
    : MeshRefusalCode.AudienceMismatch;
};

/** Why a signed envelope is refused at `now`; `undefined` when it holds. */
export function signatureRefusalOf(
  read: ReadEnvelope,
  key: KeyObject,
  now: Date,
): MeshRefusalCode | undefined {
  if (read.signed === undefined || !isSignedBy(read.signed, key))
    return MeshRefusalCode.SignatureInvalid;
  const issuedAt = Date.parse(read.envelope.issuedAt ?? "");
  const lifetime = millisecondsOf(read.envelope.expiresIn);
  if (Number.isNaN(issuedAt) || lifetime === undefined) return MeshRefusalCode.EnvelopeExpired;
  const at = now.getTime();
  const isValid = issuedAt - CLOCK_TOLERANCE <= at && at <= issuedAt + lifetime + CLOCK_TOLERANCE;
  return isValid ? undefined : MeshRefusalCode.EnvelopeExpired;
}
