import { createPrivateKey, type KeyObject } from "node:crypto";
import { ENVELOPE_LIFETIME } from "../mesh/mesh-defaults.js";
import { isoDurationOf } from "../mesh/mesh-durations.js";
import type {
  MeshBudgetClaim,
  MeshDeadlineClaim,
  MeshEnvelope,
  MeshOrigin,
} from "../mesh/mesh-envelope.js";
import { encodeMeshEnvelope } from "../mesh/mesh-envelope-codec.js";
import type { MeshHop } from "../mesh/mesh-hop.js";
import { bodyHashOf } from "../mesh/outbound-mesh.js";
import type { Milliseconds } from "../units/index.js";
import { TestSetupError } from "./errors.js";

/**
 * A signed mesh envelope for a test (#521): the `agboss-mesh` header value (A2A) or the
 * `_meta["agboss.dev/mesh"]` value (MCP) a calling application sends — the framework's own encoder,
 * so a store's or a project's mesh test speaks the real wire format instead of building the JWS
 * by hand. The receiver trusts it only when its caller resolver names `issuer` as the peer and its
 * `mesh.peers` key verifies the signature.
 */
export interface SignedMeshEnvelopeOptions {
  /** The calling application (its `@Application({ name })`): the peer that signs. */
  readonly issuer: string;
  /** The receiving application it is meant for; another receiver refuses it (`401`). Unset → none. */
  readonly audience?: string;
  /** The issuer's Ed25519 private key: a `KeyObject`, or its PKCS #8 PEM (what `mesh.signingKey` holds). */
  readonly signingKey: KeyObject | string;
  /** The request's body (A2A) or arguments (MCP) as sent: its `bodyHash` binds the envelope to the call. */
  readonly body: string;
  /** When the caller signed it, on the caller's clock — a test's `clock.now()`. */
  readonly issuedAt: Date;
  /**
   * The calling execution and step; `origin.step.idempotencyKey` is the request's — a retry
   * repeats it, so a receiver with a durable `MeshRequestRepository` answers it once.
   */
  readonly origin: MeshOrigin;
  /** The applications the request passed through, the first caller first, the caller last. */
  readonly callChain: readonly MeshHop[];
  /** How long it is valid after `issuedAt` (default 60 seconds, as the framework signs). */
  readonly lifetime?: Milliseconds;
  /** What the calling execution may still spend: the receiver lowers its own limit to it. */
  readonly budget?: MeshBudgetClaim;
  /** How long the caller still waits: the receiver's execution deadline. */
  readonly deadline?: MeshDeadlineClaim;
}

const NOT_A_SIGNING_KEY = "the mesh signs with an Ed25519 private key";

/** A PEM's private key; a PEM that holds none is a setup mistake. */
function privateKeyOf(pem: string): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new TestSetupError(
      `signedMeshEnvelope: signingKey holds no private key (${why}) — ${NOT_A_SIGNING_KEY}`,
    );
  }
}

/** The private key, from a `KeyObject` or a PEM; anything but Ed25519 is a setup mistake. */
function signingKeyOf(signingKey: KeyObject | string): KeyObject {
  const key = typeof signingKey === "string" ? privateKeyOf(signingKey) : signingKey;
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw new TestSetupError(
      `signedMeshEnvelope: signingKey is a ${key.type} ${String(key.asymmetricKeyType)} key — ${NOT_A_SIGNING_KEY}`,
    );
  return key;
}

/**
 * The `agboss-mesh` value an application with `mesh.signingKey` sends for `body` (`EdDSA`, schema 1)
 * — its fields in the client's order, so the same call gives the same text.
 */
export function signedMeshEnvelope(options: SignedMeshEnvelopeOptions): string {
  const envelope: MeshEnvelope = {
    schema: 1,
    issuer: options.issuer,
    origin: options.origin,
    callChain: options.callChain,
    issuedAt: options.issuedAt.toISOString(),
    expiresIn: isoDurationOf(options.lifetime ?? ENVELOPE_LIFETIME),
    bodyHash: bodyHashOf(options.body),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.audience === undefined ? {} : { audience: options.audience }),
  };
  return encodeMeshEnvelope(envelope, signingKeyOf(options.signingKey));
}
