import type { Secret } from "agboss";

/**
 * job-scout's environment contract (#261): declared fields only — the values are in each
 * `<name>.environment.ts` here. Declared once: `@Application({ environment: AppEnvironment })`;
 * `GreenhouseBoards` reads it as `applicationContext.environment` (`deps: [ApplicationContext]`).
 */
export class AppEnvironment {
  /**
   * OpenRouter's key — read by both model providers (`apiKey: "openRouterApiKey"`, #266). Set in
   * the environments that call models; `test` leaves it out: tests script or replay every model.
   */
  openRouterApiKey?: Secret;
  /** The Greenhouse job-board API. */
  greenhouseApiUrl!: string;
  /** The file of the SQLite implementations the application lists (`:memory:` in tests). */
  sqlitePath!: string;
}
