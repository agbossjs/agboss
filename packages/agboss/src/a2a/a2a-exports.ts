import type { Class } from "../components/injection.js";
import { ComponentError, requireComponent } from "../components/metadata.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import type { A2AApp } from "./a2a-caller.js";

/**
 * The starts a listener serves (#398 PR 3): its `@A2AExpose`'s exports. The expose must be listed in
 * `@Application({ exposes })` — `[application.expose-unlisted]` — so what `agboss describe` lists as
 * exported is what is served: each export is one skill of the listener's Agent Card (#808).
 */

/** The exports of a listener's expose, checked against the application's `exposes`. */
export function exportsOf(app: A2AApp, expose: Class): readonly Class[] {
  const { meta } = requireComponent(expose, "a2a-expose", "a2aHttpListener expose");
  const listed = meshSettingsOf(app)?.exposes;
  if (listed !== undefined && !listed.includes(expose)) {
    throw new ComponentError(
      `[application.expose-unlisted] ${expose.name} is not listed in @Application({ exposes }) — list it there: what is served is what describe lists`,
    );
  }
  return meta.exports;
}
