import { env, secret } from "../../../../../src/index.js";
import type { MeshEnvironment } from "../../../fixtures/environments/mesh.environment.js";

export const environment: MeshEnvironment = {
  meshSigningKey: secret("MESH_SIGNING_KEY"),
  meshPeerKey: env("MESH_PEER_KEY"),
};
