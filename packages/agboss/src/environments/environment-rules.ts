/**
 * The rules a `defineEnv` value (or a secret a component names) can break (#1324b): the error is
 * always `ConfigError.Environment` (`config.environment`), and its message names the rule in square
 * brackets, as the assembly rules do — `[environment.missing-variable] DATABASE_URL is not set
 * (databaseUrl)`. A message names variables, never values.
 */

/** A rule of the environment: a variable that is not set, or one whose value does not fit. */
export type EnvironmentRule = "environment.missing-variable" | "environment.invalid-value";

/** `[environment.missing-variable] text`. */
export const missingVariable = (text: string): string => `[environment.missing-variable] ${text}`;

/** `[environment.invalid-value] text`. */
export const invalidValue = (text: string): string => `[environment.invalid-value] ${text}`;
