import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { MeshOptions } from "../../../src/index.js";

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

/** `mesh` of an application that signs with `meshSigningKey` and verifies `peer` by `meshPeerKey`. */
export const meshOf = (peer: string): MeshOptions => ({
  signingKey: "meshSigningKey",
  peers: [{ application: peer, verifyKey: "meshPeerKey" }],
});

/** The process variables `dev.environment.ts` reads: its own private key, its peer's public key. */
export const meshEnvOf = (own: MeshKeyPair, peer: MeshKeyPair): NodeJS.ProcessEnv => ({
  MESH_SIGNING_KEY: own.privatePem,
  MESH_PEER_KEY: peer.publicPem,
});
