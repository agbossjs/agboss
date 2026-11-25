import { ComponentError } from "../components/metadata.js";
import type { MeshSettings } from "../mesh/mesh-settings.js";
import { interfaceUrlOf } from "./a2a-public-url.js";
import { Ttl } from "../units/index.js";
import type { ListenerAuthenticator } from "./a2a-caller-gate.js";
import type { A2AEndpointMeta } from "./a2a-endpoint.decorator.js";
import type { A2AHttpListenerOptions } from "./a2a-http.js";
import type { AgentCardSource } from "./server/a2a-card.js";

/** The listener's `publicUrl`, asked when it is a function: a text, else the function's failure as a refusal. */
export function publicUrlOf(options: A2AHttpListenerOptions): string {
  if (typeof options.publicUrl === "string") return options.publicUrl;
  let url: unknown;
  try {
    url = options.publicUrl();
  } catch (cause) {
    throw new ComponentError({
      message: "[a2a.public-url-invalid] a2aHttpListener's publicUrl function threw",
      cause,
    });
  }
  if (typeof url !== "string")
    throw new ComponentError({
      message: "[a2a.public-url-invalid] a2aHttpListener's publicUrl function gave no text",
    });
  return url;
}

/** What a binding knows of its listener: its authenticator and its interface URL, checked when it is made or asked now. */
export function knownOf(
  options: A2AHttpListenerOptions,
  checked: {
    readonly authenticator: ListenerAuthenticator | undefined;
    readonly url: string | undefined;
  },
): { readonly authenticator: ListenerAuthenticator | undefined; readonly url: string } {
  return {
    authenticator: checked.authenticator,
    url: checked.url ?? interfaceUrlOf(publicUrlOf(options), options.base ?? ""),
  };
}

/** What a card advertises of a task ttl: `Ttl.Forever` as the longest duration a card can say. */
const advertisedRetentionOf = (ttl: A2AEndpointMeta["ttl"]["tasks"]): number =>
  ttl === Ttl.Forever ? FOREVER_ADVERTISED : ttl;

/** What a card advertises for `Ttl.Forever`: a century. */
const FOREVER_ADVERTISED = 100 * 365 * 24 * 60 * 60 * 1000;

/** What the card says besides the endpoint and the skills (the card builder's source less them). */
export type CardSource = Omit<AgentCardSource, "expose" | "skills" | "madeAt">;

/** What the card says besides the endpoint and the skills: the application, the URL, the retention, who runs it. */
export function cardSourceOf(
  mesh: MeshSettings,
  endpoint: A2AEndpointMeta,
  checked: { readonly authenticator: ListenerAuthenticator | undefined; readonly url: string },
): CardSource {
  return {
    application: mesh.application,
    url: checked.url,
    idempotencyRetention: advertisedRetentionOf(endpoint.ttl.tasks),
    messageIdempotencyRetention: endpoint.ttl.messages,
    schemes: checked.authenticator?.meta.schemes ?? [],
    ...(endpoint.provider === undefined ? {} : { provider: endpoint.provider }),
  };
}
