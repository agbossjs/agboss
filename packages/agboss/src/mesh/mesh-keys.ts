import { ConfigError } from "../core/error-families/config-errors.js";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { resolveReferences } from "../environments/define-env.js";
import { Secret } from "../environments/secret.js";
import type { MeshMeta, MeshPeer } from "./mesh.decorator.js";

/**
 * The application's mesh keys (#398 PR 2, #1320), read from the process environment at start: its own
 * private key and each peer's public keys, Ed25519 in PEM. A key that holds no such key fails the
 * start, naming the peer or the field and never the value.
 */
export interface MeshKeys {
  /** `@Mesh({ signingKey })`: this application signs its envelopes, run reports and requests with it. */
  readonly signingKey?: KeyObject;
  /**
   * `@Mesh({ peers })`: each peer's public keys, by its application name. Any of them verifies — during
   * a rotation the old and the new one are both listed — and no other does.
   */
  readonly peers: ReadonlyMap<string, readonly KeyObject[]>;
}

/** A mesh key that holds no key of the expected kind, or a peer left with none. */
const textOf = (value: unknown): string | undefined =>
  value instanceof Secret ? value.reveal() : typeof value === "string" ? value : undefined;

const ED25519 = "ed25519";

function keyOf(
  where: string,
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
    throw new ConfigError.Component({
      message: `[mesh.invalid-key] ${where} holds no ${what} (${why})`,
    });
  }
}

/** The public keys of one peer: every listed key that is set, each an Ed25519 key, at least one. */
function peerKeysOf(peer: MeshPeer, env: NodeJS.ProcessEnv): readonly KeyObject[] {
  const where = `mesh peer ${peer.application}`;
  const resolved = resolveReferences({ keys: [...peer.verifyKeys] }, env, where);
  const values = (resolved.keys as readonly unknown[]).filter((value) => value !== undefined);
  const keys = values.map((value, index) =>
    keyOf(
      `${where} verifyKeys[${String(index)}]`,
      value,
      createPublicKey,
      "Ed25519 public key (SPKI PEM)",
    ),
  );
  if (keys.length === 0)
    throw new ConfigError.Component({
      message: `[mesh.peer-without-keys] ${where} has no verification key set`,
    });
  return keys;
}

/** The keys `mesh` names, read from the process environment. */
export function meshKeysOf(mesh: MeshMeta | undefined, env: NodeJS.ProcessEnv): MeshKeys {
  const peers = new Map<string, readonly KeyObject[]>();
  for (const peer of mesh?.peers ?? []) peers.set(peer.application, peerKeysOf(peer, env));
  const reference = mesh?.signingKey;
  if (reference === undefined) return { peers };
  const resolved = resolveReferences({ signingKey: reference }, env, "mesh signingKey");
  const signingKey = keyOf(
    "mesh signingKey",
    resolved.signingKey,
    (pem) => createPrivateKey(pem),
    "Ed25519 private key (PKCS #8 PEM)",
  );
  return { signingKey, peers };
}
