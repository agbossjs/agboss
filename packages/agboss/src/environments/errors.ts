import { AGBossError } from "../core/errors.js";

/** Why an environment cannot be used (#261): the stable `code` of an `EnvironmentError`. */
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

/** What an environment error takes (#906): why, and the sentence. */
export interface EnvironmentErrorOptions {
  readonly code: EnvironmentErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/** An environment that cannot be used: not found, a variable missing or invalid (`code` tells which). */
export class EnvironmentError extends AGBossError {
  static override readonly code: string = "environment";
  declare readonly code: EnvironmentErrorCode;
  override name = "EnvironmentError";

  constructor(options: EnvironmentErrorOptions) {
    super(options.message, options);
    this.code = options.code;
  }
}
