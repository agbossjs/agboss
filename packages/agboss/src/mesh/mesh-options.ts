import type { Milliseconds } from "../units/index.js";

/**
 * `@Application({ mesh })` (#398 PR 2): the application's identity in the mesh. With `signingKey`
 * every envelope it sends and every run report it returns is signed (JWS `EdDSA`); `peers` are the
 * applications whose envelopes it can verify — a request is trusted only when the caller resolver
 * names its `peer` and the envelope carries that peer's valid signature. `maxMeshHops` stays a
 * setting of its own.
 */
export interface MeshOptions {
  /**
   * The `Secret` field of the environment holding this application's private key — an Ed25519 key
   * in PKCS #8 PEM (`-----BEGIN PRIVATE KEY-----`), as a `@ModelProvider`'s `apiKey` names its
   * field (`[mesh.signing-key-missing]` when the contract lacks it). Unset → envelopes unsigned.
   */
  readonly signingKey?: string;
  /** The applications whose signatures it verifies, each with its public key's field. */
  readonly peers?: readonly MeshPeer[];
  /**
   * How long a trusted request's answer is kept for a repeat of its idempotency key
   * (`MeshRequestRepository`, removed by the recovery sweep on the `Clock`). Default `minutes(30)`.
   */
  readonly idempotencyRetention?: Milliseconds;
}

/** A peer of the mesh: its `@Application({ name })` and the field of its public key. */
export interface MeshPeer {
  /** The peer's application name — the `issuer` of its envelopes, the `peer` a resolver names. */
  readonly application: string;
  /**
   * The text field of the environment holding the peer's public key — Ed25519 in SPKI PEM
   * (`-----BEGIN PUBLIC KEY-----`); `[mesh.unknown-peer-key]` when the contract lacks it.
   */
  readonly verifyKey: string;
}
