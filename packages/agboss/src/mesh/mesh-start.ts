import type { App } from "../app/types.js";
import { rememberA2AClientServicesOf } from "../a2a/client/a2a-client-services.js";
import type { AssembledApplication } from "../application/assemble.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { Clock, lazyLoad } from "../infrastructure/clock.js";
import { meshKeysOf } from "./mesh-keys.js";
import { rememberContextMeshSettings, type MeshSettings } from "./mesh-settings.js";

/**
 * An application instance's mesh settings at its start (#398): its keys read from its environment
 * (a field without a valid key fails the start), remembered for its `ApplicationContext` too.
 */
export function meshSettingsFor(
  assembled: AssembledApplication,
  app: Pick<App, "resolve">,
): MeshSettings {
  const context = app.resolve(ApplicationContext);
  const settings: MeshSettings = {
    application: assembled.name,
    maxMeshHops: assembled.maxMeshHops,
    keys: meshKeysOf(assembled.mesh, context.environment),
    clock: app.resolve(Clock),
    idempotencyRetention: assembled.meshAnswerRetention,
    a2aTaskRetention: assembled.a2aTaskRetention,
    exposes: assembled.exposes,
    contracts: async () =>
      (await lazyLoad(import("../describe/contracts.js"))).contractsOf(assembled),
  };
  rememberContextMeshSettings(context, settings);
  // #809: the client side — what an A2A client's calls use (OutboundCalls, the Clock), by frame
  rememberA2AClientServicesOf(app);
  return settings;
}
