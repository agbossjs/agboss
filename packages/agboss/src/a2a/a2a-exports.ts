import { ComponentOptions } from "../components/component-options.js";
import type { Class } from "../components/injection.js";
import { ComponentError, requireComponent } from "../components/metadata.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import type { A2AApp } from "./a2a-caller.js";
import type { A2AEndpointMeta } from "./a2a-endpoint.decorator.js";

/**
 * What a listener serves (#398 PR 3, #1320): its `@A2AEndpoint`. The endpoint must be listed in
 * `@Application({ endpoints })` — `[application.endpoint-unlisted]` — so what `agboss describe` lists as
 * exported is what is served: each skill is one skill of the listener's Agent Card (#808).
 */

/** The options of a listener's endpoint, checked against the application's `endpoints`. */
export function endpointOf(app: A2AApp, endpoint: Class): A2AEndpointMeta {
  const { meta } = requireComponent(endpoint, "a2a-endpoint", "a2aHttpListener endpoint");
  const listed = meshSettingsOf(app)?.endpoints;
  if (listed !== undefined && !listed.includes(endpoint)) {
    throw new ComponentError({
      message: `[application.endpoint-unlisted] ${endpoint.name} is not listed in @Application({ endpoints }) — list it there: what is served is what describe lists`,
    });
  }
  // what a profile's `a2aEndpoints` shelf leaves of its options: the ttl the card says and the sweep keeps
  return app.resolve(ComponentOptions).a2aEndpointMetaOf(endpoint) ?? meta;
}
