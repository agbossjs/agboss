/** How an environment variable is read: a secret is never printed, a default fills in when unset. */
export interface EnvironmentVariableOptions {
  readonly secret: boolean;
  /** The value when the variable is unset or empty. */
  readonly defaultValue?: string;
}

export class MissingEnvironmentVariableError extends Error {
  override name = "MissingEnvironmentVariableError";
}

/**
 * A setting read from the process environment, named in the code and never written into it:
 * `EnvironmentVariable.named("OPENROUTER_BASE_URL", { secret: false, defaultValue: "…" })`
 * — a provider's `baseUrl`; its key is a `Secret` of the application's environment (`apiKey`).
 */
export class EnvironmentVariable {
  private constructor(
    readonly name: string,
    readonly isSecret: boolean,
    readonly defaultValue: string | undefined,
  ) {}

  static named(
    name: string,
    options: EnvironmentVariableOptions = { secret: false },
  ): EnvironmentVariable {
    return new EnvironmentVariable(name, options.secret, options.defaultValue);
  }

  /** The value in `env`, the default when unset; `undefined` when neither. */
  valueIn(env: NodeJS.ProcessEnv): string | undefined {
    const value = env[this.name];
    return value === undefined || value === "" ? this.defaultValue : value;
  }

  /** The value in `env`; fails when it is unset and has no default. */
  requireIn(env: NodeJS.ProcessEnv): string {
    const value = this.valueIn(env);
    if (value === undefined) throw new MissingEnvironmentVariableError(`${this.name} is not set`);
    return value;
  }

  toString(): string {
    return `$${this.name}`;
  }
}

/** A setting given as a literal or read from the environment. */
export type SettingValue = string | EnvironmentVariable;

export const settingValueIn = (value: SettingValue, env: NodeJS.ProcessEnv): string =>
  typeof value === "string" ? value : value.requireIn(env);
