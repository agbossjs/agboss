import type { Environment } from "../flow/generated-types.js";
import { UnavailableValue } from "./container/container.js";
import { InjectionToken } from "./injection.js";

/**
 * The application's environment (#182, #261): the values of `environments/<name>.environment.ts`,
 * typed by `@Application({ environment: AppEnvironment })` through the generated types —
 * `@Injectable({ deps: [ENV] })`, `constructor(environment: AppEnvironment)`. #261 PR 3 reads it
 * as `applicationContext.environment` instead.
 */
export const ENV = new InjectionToken<Environment>("ENV");

const missingEnvironment = new UnavailableValue(
  (dependant) =>
    `[di.missing-environment] ${dependant} injects ENV, but the application declares no environment: add @Application({ environment: AppEnvironment }) and environments/<name>.environment.ts next to the application file (export const environment: AppEnvironment = { … })`,
);

/** What a container registers under `ENV`: the environment, or a value failing when injected. */
export const environmentValueOf = (environment: Environment | undefined): unknown =>
  environment ?? missingEnvironment;
