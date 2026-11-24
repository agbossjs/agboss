import type { Secret } from "@agboss/core";

/**
 * The patterns' environment contract (#261): declared fields only — the values are in each
 * `<name>.environment.ts` here. The rows' place and the application's keys are not here: they
 * are `src/storage/` (`@DatabaseStorage`, #1321), read through `defineEnv`.
 */
export class AppEnvironment {
  /**
   * OpenRouter's key — read by both built-in model providers (#266) for a real run. `test` leaves
   * it out: tests script every model.
   */
  openRouterApiKey?: Secret;
  /** OpenRouter's base URL (a proxy, a local server); unset → the providers' default. */
  openRouterBaseUrl?: string;
}
