import type { Class } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import type { EnvRef, OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import { resolvedName } from "../flow/names.js";
import type { Milliseconds } from "../units/index.js";

/** Whether a request to a mesh endpoint must come signed by a peer of the mesh. */
export enum MeshInboundMode {
  /** Only a request signed by a peer of the mesh is admitted (`X-AGBoss-Mesh`). */
  Strict = "strict",
  /** A request that is no mesh call (an `@HttpAuthenticator`'s caller) is admitted as well. */
  AllowExternal = "allow-external",
}

/** One verification key of a peer: a reference to its public key (Ed25519, SPKI PEM). */
export type MeshVerifyKey = SecretRef | OptionalSecretRef | EnvRef<string | undefined>;

/**
 * A peer of the mesh: the `@Application({ name })` whose signatures this application verifies.
 * Several `verifyKeys` let a peer rotate its key without a break: the new public key is deployed
 * here first, then the peer switches its `signingKey`; any listed key verifies, no other does. A
 * key that is optional and not set is left out; a peer left with no key fails the start.
 */
export interface MeshPeer {
  /** The peer's application name: the `issuer` of its envelopes and of its `X-AGBoss-Mesh` header. */
  readonly application: string;
  readonly verifyKeys: readonly MeshVerifyKey[];
  /** The `@A2AExpose` / `@McpExpose` classes the peer may call; none listed → any. */
  readonly allowEndpoints?: readonly Class[];
  /** Whether the peer's signed `tenantId` is the caller's tenant for the requests it makes. */
  readonly propagateTenant?: boolean;
}

/**
 * `@Mesh(options)`: the application's identity and rules in the mesh, listed in
 * `@Application({ mesh })`. With a `signingKey` every envelope it sends, every run report it
 * returns and every HTTP request of its clients are signed (EdDSA); `peers` are the applications
 * whose signatures it verifies — a request is trusted only when its signature is a peer's.
 */
export interface MeshOptions {
  readonly name?: string;
  readonly description?: string;
  /** Ed25519 private key, PKCS #8 PEM: `appEnv.meshSigningKey`. Unset → nothing is signed. */
  readonly signingKey?: SecretRef;
  /** Whether a request to a mesh endpoint must be signed by a peer. */
  readonly inboundMode: MeshInboundMode;
  /**
   * How long the answer of a trusted request is kept, and so how long its idempotency key is
   * deduplicated: longer than an execution's lease (30 s).
   */
  readonly deduplicationTtl: Milliseconds;
  /** How many applications one call chain may pass through, this one included; from 1. */
  readonly maxHops: number;
  /** How long an envelope or header this application signs is valid, and the longest it accepts. Default 60 s. */
  readonly envelopeTtl?: Milliseconds;
  /** How far a peer's clock may run from this one's when a signature's date is checked. Default 30 s. */
  readonly maxClockSkew?: Milliseconds;
  readonly peers?: readonly MeshPeer[];
}

/** What `@Mesh` records of its class. */
export interface MeshMeta extends MeshOptions {
  readonly name: string;
}

/**
 * The application's mesh, listed in `@Application({ mesh })`: its keys, its peers and the limits
 * of its calls. An empty class carrying its options.
 */
export function Mesh(options: MeshOptions): <C extends Class>(value: C) => C {
  return <C extends Class>(value: C): C => {
    const meta: MeshMeta = { ...options, name: resolvedName(options.name, value) };
    recordComponent(value, { kind: "mesh", meta });
    return value;
  };
}

/** What `@Mesh` recorded on a class; `undefined` when it is not a mesh. */
export function meshOf(cls: Class): MeshMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "mesh" ? component.meta : undefined;
}
