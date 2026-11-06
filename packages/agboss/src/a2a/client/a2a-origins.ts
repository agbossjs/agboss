import { A2AOriginError, A2AOriginSite } from "./a2a-guard-errors.js";

/**
 * The origins an A2A client talks to (#809, security): its `url`'s and the ones it lists in
 * `allowedOrigins`. A card's interface, a request, a redirect or an answer from anywhere else is
 * refused — the client's headers (a token, a key) never leave them.
 */

/** The origins a client may talk to. */
export interface OriginPolicy {
  readonly agent: string;
  readonly origins: readonly string[];
}

/** An origin as `new URL(…).origin` writes it, or `undefined` for anything else (`data:` too). */
export function originOf(text: string): string | undefined {
  const origin = URL.canParse(text) ? new URL(text).origin : "null";
  return origin === "null" ? undefined : origin;
}

/**
 * The origins of a client at `url` with `allowed` more (each written as an origin:
 * `https://billing.example`, no path) — a malformed entry is refused at construction.
 */
export function originPolicyOf(
  agent: string,
  url: string,
  allowed: readonly string[] = [],
): OriginPolicy {
  const own = originOf(url);
  if (own === undefined)
    throw new TypeError(`[a2a.url-invalid] ${agent}: its url is no absolute URL`);
  for (const entry of allowed) {
    if (originOf(entry) !== entry) {
      throw new TypeError(
        `[a2a.allowed-origin-invalid] ${agent}: allowedOrigins entry "${entry}" is no origin (scheme://host[:port], no path)`,
      );
    }
  }
  return { agent, origins: [...new Set([own, ...allowed])] };
}

/** Whether `url` is on one of the policy's origins. */
export const isAllowedOrigin = (policy: OriginPolicy, url: string): boolean =>
  policy.origins.some((origin) => origin === originOf(url));

/** The refusal of `url` at `site`, or `undefined` when it is on an allowed origin. */
export function originRefusalOf(
  policy: OriginPolicy,
  url: string,
  site: A2AOriginSite,
): A2AOriginError | undefined {
  if (isAllowedOrigin(policy, url)) return undefined;
  return new A2AOriginError({
    agent: policy.agent,
    origin: originOf(url) ?? "(no origin)",
    site,
    allowedOrigins: policy.origins,
  });
}
