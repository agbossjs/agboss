import type { ServerResponse } from "node:http";
import { Message, SendMessageRequest } from "@a2a-js/sdk";
import type { InboundMesh } from "../../mesh/inbound-mesh.js";
import { inboundMeshOfRequest } from "../../mesh/mesh-admission.js";
import type { MeshEnvelope } from "../../mesh/mesh-envelope.js";
import { readMeshEnvelope, type ReadEnvelope } from "../../mesh/mesh-envelope-codec.js";
import type { MeshSettings } from "../../mesh/mesh-settings.js";
import {
  audienceRefusalOf,
  MESH_REFUSAL_TEXT,
  MeshRefusalCode,
  signatureRefusalOf,
} from "../../mesh/mesh-verification.js";
import { writeRejection } from "../a2a-caller-gate.js";
import { A2AOperation } from "../a2a-caller.js";
import { meshBodyHashOf, meshEnvelopeTextOf } from "../a2a-mesh-message.js";

/**
 * The A2A server's inbound mesh check (#810, design §4.1.2 step 3) — what MCP's receiver does
 * (`mcp-mesh-gate.ts`), on the A2A v1.0 wire: the caller's envelope is the compact JWS in
 * `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope` of a `SendMessage` /
 * `SendStreamingMessage`, read from the message as the SDK's transport decodes it (the same
 * decoder the handler is given, so what is checked is what runs). Before the caller resolver and
 * before anything runs: an envelope addressed to another application, or signed and addressed to
 * none, is refused first — `audienceRefusalOf` against the application's own name, before any
 * signature is looked at (fail closed: the name is the application's, mesh settings or not); a
 * signed envelope of a known peer then has its signature, its replay window and its `bodyHash`
 * (`meshBodyHashOf` of the decoded message) checked. A refusal is HTTP `401 { code, error }`. An
 * envelope that cannot be read is no claim (as on MCP); a signed one of an unknown issuer is an
 * unsigned claim: its chain is checked, nothing of it trusted.
 */

/** What a request's mesh is once its envelope held: read before the resolver, trusted after it. */
export interface A2ARequestMesh {
  /** The envelope it carried (a claim unless `trustedPeer` is set). */
  readonly envelope: MeshEnvelope | undefined;
  /** `meshBodyHashOf` of the message as decoded: what a run report binds; none without one. */
  readonly bodyHash: string | undefined;
  /** The issuer whose signature verified, when it is the peer the resolver authenticated. */
  readonly trustedPeer: string | undefined;
  /** The caller's `traceparent` header. */
  readonly traceparent: string | undefined;
}

/** A request's envelope, checked: held (and whose signature verified), or refused with a code. */
export type A2AMeshVerdict =
  | {
      readonly isAdmitted: true;
      readonly envelope: MeshEnvelope | undefined;
      readonly bodyHash: string | undefined;
      /** The issuer whose signature, replay window and body hash all held. */
      readonly verifiedIssuer: string | undefined;
    }
  | { readonly isAdmitted: false; readonly code: MeshRefusalCode };

const HTTP_UNAUTHORIZED = 401;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The operations whose message may carry an envelope. */
const MESSAGE_OPERATIONS: ReadonlySet<A2AOperation> = new Set([
  A2AOperation.SendMessage,
  A2AOperation.SendStreamingMessage,
]);

/** The message of a send's body as the transport decodes it, back in its wire JSON. */
function wireMessageOf(body: unknown): unknown {
  const params = isRecord(body) ? body.params : undefined;
  if (!isRecord(params)) return undefined;
  const message = SendMessageRequest.fromJSON(params).message;
  return message === undefined ? undefined : Message.toJSON(message);
}

/** Why a signed envelope of a known issuer is refused; `undefined` when it holds or is no such one. */
function signedRefusalOf(
  settings: MeshSettings,
  read: ReadEnvelope,
  bodyHash: string,
): MeshRefusalCode | undefined {
  const key = read.signed === undefined ? undefined : settings.keys.peers.get(read.envelope.issuer);
  if (key === undefined) return undefined;
  return (
    signatureRefusalOf(read, key, settings.clock.now()) ??
    (read.envelope.bodyHash === bodyHash ? undefined : MeshRefusalCode.BodyMismatch)
  );
}

/**
 * Checks the envelope of one admitted request of `application` (the receiver's own name, the
 * audience it must be addressed to). A request of another operation, or with no message, carries
 * none: admitted as it is.
 */
export function admitA2AMesh(
  settings: MeshSettings,
  operation: A2AOperation,
  body: unknown,
): A2AMeshVerdict {
  const message = MESSAGE_OPERATIONS.has(operation) ? wireMessageOf(body) : undefined;
  if (message === undefined)
    return {
      isAdmitted: true,
      envelope: undefined,
      bodyHash: undefined,
      verifiedIssuer: undefined,
    };
  const bodyHash = meshBodyHashOf(message);
  const read = readMeshEnvelope(meshEnvelopeTextOf(message));
  if (read === undefined)
    return { isAdmitted: true, envelope: undefined, bodyHash, verifiedIssuer: undefined };
  // the audience first, whoever signed it (#809 security): an envelope for someone else never runs
  const refusal =
    audienceRefusalOf(read, settings.application) ?? signedRefusalOf(settings, read, bodyHash);
  if (refusal !== undefined) return { isAdmitted: false, code: refusal };
  const isVerified = read.signed !== undefined && settings.keys.peers.has(read.envelope.issuer);
  return {
    isAdmitted: true,
    envelope: read.envelope,
    bodyHash,
    verifiedIssuer: isVerified ? read.envelope.issuer : undefined,
  };
}

/** The request's envelope as checked; `undefined` once refused (`401 { code, error }`). */
export function admittedMeshOf(
  settings: MeshSettings,
  operation: A2AOperation,
  body: unknown,
  res: ServerResponse,
): Extract<A2AMeshVerdict, { readonly isAdmitted: true }> | undefined {
  const verdict = admitA2AMesh(settings, operation, body);
  if (verdict.isAdmitted) return verdict;
  writeRejection(res, HTTP_UNAUTHORIZED, {
    code: verdict.code,
    error: MESH_REFUSAL_TEXT[verdict.code],
  });
  return undefined;
}

/**
 * The request's mesh once the resolver answered: trusted only when the peer it authenticated is the
 * envelope's verified issuer (#398 PR 2).
 */
export const requestMeshOf = (
  verdict: Extract<A2AMeshVerdict, { readonly isAdmitted: true }>,
  peer: string | undefined,
  traceparent: string | undefined,
): A2ARequestMesh => ({
  envelope: verdict.envelope,
  bodyHash: verdict.bodyHash,
  trustedPeer:
    peer !== undefined && verdict.verifiedIssuer === peer ? verdict.verifiedIssuer : undefined,
  traceparent,
});

/** What the request's execution runs with: its chain, its trace, a trusted caller's claims. */
export const inboundMeshOfA2A = (mesh: A2ARequestMesh | undefined): InboundMesh | undefined =>
  mesh === undefined
    ? undefined
    : inboundMeshOfRequest(mesh.envelope, mesh.traceparent, mesh.trustedPeer);
