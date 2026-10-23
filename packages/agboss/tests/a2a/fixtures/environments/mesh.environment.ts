import type { Secret } from "../../../../src/index.js";

/** The keys of a signing mesh application (#398 PR 2): its own, and its one peer's. */
export class MeshEnvironment {
  meshSigningKey!: Secret;
  meshPeerKey!: string;
}
