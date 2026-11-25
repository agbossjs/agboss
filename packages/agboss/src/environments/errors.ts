/** Why an environment cannot be used (#261): the stable `code` of an `ConfigError.Environment`. */
export enum EnvironmentErrorCode {
  /** The named `environments/<name>.environment.ts` is missing, or exports no `environment`. */
  NotFound = "environment.not-found",
  /** A process variable the environment reads is not set. */
  MissingVariables = "environment.missing-variables",
  /** A process variable's value is not of its field's type (`env.integer`, `env.flag`). */
  InvalidValue = "environment.invalid-value",
  /** An environment named for an application that declares no `environment` contract. */
  NoContract = "environment.no-contract",
}
