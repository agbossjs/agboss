import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { Mesh, MeshInboundMode, type MeshOptions } from "../../../src/index.js";
import type { Class } from "../../../src/components/injection.js";
import { defineEnv } from "../../../src/environments/define-env.js";
import { secret } from "../../../src/environments/secret.js";
import { minutes } from "../../../src/units/index.js";

/** An Ed25519 pair of a mesh application, as PEM (its environment's values) and as keys. */
export interface MeshKeyPair {
  readonly privatePem: string;
  readonly publicPem: string;
  readonly privateKey: KeyObject;
}

export function meshKeyPair(): MeshKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

/** The process variables the test mesh reads: its own private key, its peer's public key. */
export const meshEnv = defineEnv({
  signingKey: secret("MESH_SIGNING_KEY"),
  peerKey: secret("MESH_PEER_KEY"),
});

/** A `@Mesh` that signs with `signingKey` and verifies `peer` by `peerKey` (`options` over the defaults). */
export function meshOf(peer: string, options: Partial<MeshOptions> = {}): Class {
  @Mesh({
    name: "test-mesh",
    signingKey: meshEnv.signingKey,
    inboundMode: MeshInboundMode.AllowExternal,
    deduplicationTtl: minutes(30),
    maxHops: 8,
    peers: [{ application: peer, verifyKeys: [meshEnv.peerKey] }],
    ...options,
  })
  class TestMesh {}
  return TestMesh;
}

/** The process variables `dev.environment.ts` reads: its own private key, its peer's public key. */
export const meshEnvOf = (own: MeshKeyPair, peer: MeshKeyPair): NodeJS.ProcessEnv => ({
  MESH_SIGNING_KEY: own.privatePem,
  MESH_PEER_KEY: peer.publicPem,
});
