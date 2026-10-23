import type { MeshVerifier } from "../../../src/a2a/index.js";
import type { Class } from "../../../src/components/injection.js";
import { Injectable } from "../../../src/index.js";

/** A listener's `meshVerifier` that knows the given peers' public keys (PEM). */
export function meshVerifierOf(keys: Readonly<Record<string, string>>): Class<MeshVerifier> {
  @Injectable()
  class KnownPeersVerifier implements MeshVerifier {
    verifyKeyOf(issuer: string): string | undefined {
      return keys[issuer];
    }
  }
  return KnownPeersVerifier;
}
