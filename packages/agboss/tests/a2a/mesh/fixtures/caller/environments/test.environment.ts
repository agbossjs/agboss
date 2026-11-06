import { env, secret } from "../../../../../../src/index.js";
import type { MeshEnvironment } from "../../../../fixtures/environments/mesh.environment.js";
import "../../keys.js";

export const environment: MeshEnvironment = {
  meshSigningKey: secret("E2E_CALLER_SIGNING_KEY"),
  meshPeerKey: env("E2E_PEER_VERIFY_KEY"),
};
