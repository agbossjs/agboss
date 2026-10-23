import type { Class } from "../components/injection.js";
import { ComponentError, requireComponent } from "../components/metadata.js";
import { nameOf } from "../components/name-of.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import type { A2AApp } from "./a2a-caller.js";

/**
 * The starts a listener serves (#398 PR 3): its `@A2AExpose`'s exports. The expose must be listed in
 * `@Application({ exposes })` — `[application.expose-unlisted]` — so what `agboss describe` lists as
 * exported is what is served. A request names its start (`{ start }`, an `@A2AAgent`'s
 * `target.start`); with one export it may leave it out.
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

/** Why a request names no export it may run. */
export interface StartRefusal {
  readonly code: "a2a.unknown-start";
  readonly error: string;
}

/** The export a request runs: its `start`, or the only one; else why not. */
export function exportedStartOf(
  exports: readonly Class[],
  start: string | undefined,
): Class | StartRefusal {
  const names = exports.map((exported) => nameOf(exported));
  if (start === undefined) {
    const [only] = exports;
    if (exports.length === 1 && only !== undefined) return only;
    return {
      code: "a2a.unknown-start",
      error: `name the start to run: one of ${names.join(", ")}`,
    };
  }
  const found = exports.find((exported) => nameOf(exported) === start);
  return (
    found ?? {
      code: "a2a.unknown-start",
      error: `${start} is not exported here (${names.join(", ")})`,
    }
  );
}
