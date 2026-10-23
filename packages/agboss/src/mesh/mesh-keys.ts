import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { Secret } from "../environments/secret.js";
import type { MeshOptions } from "./mesh-options.js";

/**
 * The application's mesh keys (#398 PR 2), read from its environment at start: its own private
 * key and each peer's public key, Ed25519 in PEM. A field that holds no such key fails the start,
 * naming the field and never the value.
 */
export interface MeshKeys {
  /** `mesh.signingKey`: this application signs its envelopes and run reports with it. */
  readonly signingKey?: KeyObject;
  /** `mesh.peers`: each peer's public key, by its application name. */
  readonly peers: ReadonlyMap<string, KeyObject>;
}

/** A mesh key field that holds no key of the expected kind. */
export class MeshKeyError extends Error {
  override name = "MeshKeyError";
}

const textOf = (value: unknown): string | undefined =>
  value instanceof Secret ? value.reveal() : typeof value === "string" ? value : undefined;

const ED25519 = "ed25519";

function keyOf(
  field: string,
  value: unknown,
  read: (pem: string) => KeyObject,
  what: string,
): KeyObject {
  const pem = textOf(value);
  try {
    if (pem === undefined) throw new Error("not set");
    const key = read(pem);
    if (key.asymmetricKeyType !== ED25519)
      throw new Error(`a ${String(key.asymmetricKeyType)} key`);
    return key;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new MeshKeyError(`[mesh.invalid-key] ${field} holds no ${what} (${why})`);
  }
}

/** The keys `mesh` names, from the environment's values. */
export function meshKeysOf(mesh: MeshOptions | undefined, environment: object): MeshKeys {
  const peers = new Map<string, KeyObject>();
  for (const peer of mesh?.peers ?? []) {
    const value: unknown = Reflect.get(environment, peer.verifyKey);
    peers.set(
      peer.application,
      keyOf(peer.verifyKey, value, createPublicKey, "Ed25519 public key (SPKI PEM)"),
    );
  }
  const field = mesh?.signingKey;
  if (field === undefined) return { peers };
  const signingKey = keyOf(
    field,
    Reflect.get(environment, field),
    (pem) => createPrivateKey(pem),
    "Ed25519 private key (PKCS #8 PEM)",
  );
  return { signingKey, peers };
}
