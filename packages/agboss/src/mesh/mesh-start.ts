import type { App } from "../app/types.js";
import type { AssembledApplication } from "../application/assemble.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import { Clock } from "../infrastructure/clock.js";
import { DEFAULT_IDEMPOTENCY_RETENTION } from "./mesh-defaults.js";
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
    idempotencyRetention: assembled.mesh?.idempotencyRetention ?? DEFAULT_IDEMPOTENCY_RETENTION,
    exposes: assembled.exposes,
  };
  rememberContextMeshSettings(context, settings);
  return settings;
}
