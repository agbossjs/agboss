import { meshKeyPair } from "../../fixtures/mesh-keys.js";

/**
 * #810 — the mesh keys of the end-to-end tests: the calling application's and the served peer's,
 * one pair each per test process, handed to both environments through the process variables their
 * `test.environment.ts` read (set once, when this module loads).
 */

export const CALLER_KEYS = meshKeyPair();
export const PEER_KEYS = meshKeyPair();

/** A third application's keys: a signer the peer does not know. */
export const STRANGER_KEYS = meshKeyPair();

process.env.E2E_CALLER_SIGNING_KEY = CALLER_KEYS.privatePem;
process.env.E2E_CALLER_VERIFY_KEY = CALLER_KEYS.publicPem;
process.env.E2E_PEER_SIGNING_KEY = PEER_KEYS.privatePem;
process.env.E2E_PEER_VERIFY_KEY = PEER_KEYS.publicPem;
