import type { Class } from "../components/injection.js";
import type { ProfileSelection } from "../config/profile-names.js";

/** How an application is assembled: the profiles layered on it (`src/config/<name>.config.ts|yaml`). */
export interface ApplicationAssembly {
  /** `"prod"`, `"prod,economy"` (or `+`), `["prod", "economy"]`: layered left to right over `base`. */
  readonly profile?: ProfileSelection | undefined;
  /** The profile when none is named: `dev` (`createApp`, the CLI), `test` (`testWith`). */
  readonly defaultProfile?: string | undefined;
  /** Where prompt variables' `env(…)` references are read from (#1347c); default `process.env`. */
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  /**
   * The assembly is a test's (`testWith`, a unit runner, a fault pod) or runs no effect (`studio`,
   * an evaluation, a executions export): an application that names no `@DatabaseStorage` needs no
   * idempotency secret there — a test gets the test's keys. Everywhere else a component reaching
   * `Idempotency` with no secret is refused (`[application.idempotency-key-required]`).
   */
  readonly withoutIdempotencyKeys?: true | undefined;
  /**
   * What replaces the application's own `modelProvider` and `channels`, over its profiles (a test's:
   * `testWith(App, { modelProvider, channels })`): replaced as a profile's `modelProvider` and
   * `channels` replace them, never merged.
   */
  readonly replacements?: AssemblyReplacements | undefined;
}

/** The application's options a test replaces. */
export interface AssemblyReplacements {
  readonly modelProvider?: Class | undefined;
  readonly channels?: readonly Class[] | undefined;
}
