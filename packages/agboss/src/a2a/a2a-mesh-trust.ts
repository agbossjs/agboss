import { createPublicKey, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { MESH_HEADER } from "../mesh/mesh-envelope.js";
import { readMeshEnvelope, type ReadEnvelope } from "../mesh/mesh-envelope-codec.js";
import { signatureRefusalOf, type MeshRefusalCode } from "../mesh/mesh-verification.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import type { A2AApp, A2ACallerRequest, A2ARoute, MeshVerifier } from "./a2a-caller.js";

/**
 * The listener's reading of a request's envelope (#398 PR 2), before the caller resolver: an
 * envelope signed by an issuer it has a key for — the listener's `meshVerifier`, else
 * `@Application({ mesh: { peers } })` — is verified (signature, `issuedAt` + `expiresIn` on the
 * `Clock`); a bad one is refused (`401`, nothing runs), a good one names its `signedBy`. An unsigned
 * one, or one of an issuer without a key, stays a claim.
 */

/** What the resolver reads, or why the request is refused before it. */
export type ReadRequest =
  | { readonly request: A2ACallerRequest; readonly read?: ReadEnvelope }
  | { readonly refusal: MeshRefusalCode };

/** The key of `issuer`: the verifier's, else the application's peers'. */
async function keyOf(
  app: A2AApp,
  verifier: MeshVerifier | undefined,
  issuer: string,
): Promise<KeyObject | undefined> {
  const pem = await verifier?.verifyKeyOf(issuer);
  if (pem !== undefined) {
    try {
      return createPublicKey(pem);
    } catch {
      return undefined; // no key it can read: the envelope stays a claim
    }
  }
  return meshSettingsOf(app)?.keys.peers.get(issuer);
}

/** The resolver's request of `req`, its envelope verified when it can be. */
export async function readRequestOf(
  app: A2AApp,
  verifier: MeshVerifier | undefined,
  route: A2ARoute,
  req: IncomingMessage,
): Promise<ReadRequest> {
  const read = readMeshEnvelope(req.headers[MESH_HEADER]);
  if (read === undefined) return { request: { route, http: req } };
  const request = { route, http: req, envelope: read.envelope };
  if (read.signed === undefined) return { request, read };
  const key = await keyOf(app, verifier, read.envelope.issuer);
  if (key === undefined) return { request, read };
  const now = meshSettingsOf(app)?.clock.now() ?? new Date(0);
  const refusal = signatureRefusalOf(read, key, now);
  if (refusal !== undefined) return { refusal };
  return { request: { ...request, signedBy: read.envelope.issuer }, read };
}
