import { rememberAssembledContracts } from "../a2a/server/served-contracts.js";
import type { App } from "../app/types.js";
import { rememberMeshSettings } from "../mesh/mesh-settings.js";
import { meshSettingsFor } from "../mesh/mesh-start.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * What a transport built from an instance's app reads of its application (#398, #808): its mesh
 * settings, and the declared contracts an A2A listener writes its Agent Card from.
 */
export function rememberServedSettings(app: App, assembled: AssembledApplication): void {
  const mesh = meshSettingsFor(assembled, app);
  rememberMeshSettings(app, () => mesh);
  rememberAssembledContracts(app, assembled);
}
