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

/** A trusted request's facts: the peer that signed its envelope, its message's `bodyHash`. */
export interface A2ATrustedMesh {
  readonly peer: string;
  readonly bodyHash: string;
}

/** What a request's mesh is once its envelope held: read before the resolver, trusted after it. */
export interface A2ARequestMesh {
  /** The envelope it carried (a claim unless `trusted`). */
  readonly envelope: MeshEnvelope | undefined;
  /** Set when the issuer whose signature verified is the peer the resolver authenticated. */
  readonly trusted: A2ATrustedMesh | undefined;
  /** The caller's `traceparent` header. */
  readonly traceparent: string | undefined;
}

/** A request's envelope, checked: held (and whose signature verified), or refused with a code. */
export type A2AMeshVerdict =
  | {
      readonly isAdmitted: true;
      readonly envelope: MeshEnvelope | undefined;
      /** The issuer whose signature, replay window and body hash all held, with that hash. */
      readonly verified: { readonly issuer: string; readonly bodyHash: string } | undefined;
    }
  | { readonly isAdmitted: false; readonly code: MeshRefusalCode };

type Admitted = Extract<A2AMeshVerdict, { readonly isAdmitted: true }>;

const HTTP_UNAUTHORIZED = 401;

const NO_ENVELOPE: Admitted = { isAdmitted: true, envelope: undefined, verified: undefined };

/** The operations whose message may carry an envelope. */
const MESSAGE_OPERATIONS: ReadonlySet<A2AOperation> = new Set([
  A2AOperation.SendMessage,
  A2AOperation.SendStreamingMessage,
]);

/**
 * The message of a send's body as the transport decodes it, back in its wire JSON; none for a send
 * with no message (the handler answers it `-32602`). The body is an admitted one: an object whose
 * `params` the transport's decoder read (`a2a-admitted.ts`).
 */
function wireMessageOf(body: unknown): unknown {
  const { message } = SendMessageRequest.fromJSON(Reflect.get(Object(body), "params"));
  return message === undefined ? undefined : Message.toJSON(message);
}

/**
 * A known issuer's signed envelope, verified: its signature, its replay window, the message's
 * `bodyHash` — a refusal's code, or the issuer it verified; neither for an unsigned envelope or an
 * issuer the application does not know (a claim).
 */
function verifiedOf(
  settings: MeshSettings,
  read: ReadEnvelope,
  bodyHash: string,
): MeshRefusalCode | Admitted["verified"] {
  const { issuer } = read.envelope;
  const key = read.signed === undefined ? undefined : settings.keys.peers.get(issuer);
  if (key === undefined) return undefined;
  const refusal =
    signatureRefusalOf(read, key, settings.clock.now()) ??
    (read.envelope.bodyHash === bodyHash ? undefined : MeshRefusalCode.BodyMismatch);
  return refusal ?? { issuer, bodyHash };
}

/**
 * Checks the envelope of one admitted request (`settings.application`, the receiver's own name, is
 * the audience it must be addressed to). A request of another operation, or with no message,
 * carries none: admitted as it is.
 */
export function admitA2AMesh(
  settings: MeshSettings,
  operation: A2AOperation,
  body: unknown,
): A2AMeshVerdict {
  const message = MESSAGE_OPERATIONS.has(operation) ? wireMessageOf(body) : undefined;
  const read = readMeshEnvelope(meshEnvelopeTextOf(message));
  if (read === undefined) return NO_ENVELOPE;
  // the audience first, whoever signed it (#809 security): an envelope for someone else never runs
  const misaddressed = audienceRefusalOf(read, settings.application);
  if (misaddressed !== undefined) return { isAdmitted: false, code: misaddressed };
  const verified = verifiedOf(settings, read, meshBodyHashOf(message));
  return typeof verified === "string"
    ? { isAdmitted: false, code: verified }
    : { isAdmitted: true, envelope: read.envelope, verified };
}

/** The request's envelope as checked; `undefined` once refused (`401 { code, error }`). */
export function admittedMeshOf(
  settings: MeshSettings,
  operation: A2AOperation,
  body: unknown,
  res: ServerResponse,
): Admitted | undefined {
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
export function requestMeshOf(
  verdict: Admitted,
  peer: string | undefined,
  traceparent: string | undefined,
): A2ARequestMesh {
  const { verified } = verdict;
  const trusted =
    verified === undefined || verified.issuer !== peer
      ? undefined
      : { peer: verified.issuer, bodyHash: verified.bodyHash };
  return { envelope: verdict.envelope, trusted, traceparent };
}

/** What the request's execution runs with: its chain, its trace, a trusted caller's claims. */
export const inboundMeshOfA2A = (mesh: A2ARequestMesh): InboundMesh | undefined =>
  inboundMeshOfRequest(mesh.envelope, mesh.traceparent, mesh.trusted?.peer);
