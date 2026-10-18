import { inspect } from "node:util";
import { EnvironmentError, EnvironmentErrorCode } from "./errors.js";

/** What a `Secret` prints as, everywhere: logs, traces, JSON, `agboss describe`, error messages. */
export const SECRET_MASK = "***";

/** The framework's access to a secret: its variable, and a resolved copy (never public). */
interface SecretAccess {
  readonly variableOf: (secret: Secret) => string;
  readonly isResolved: (secret: Secret) => boolean;
  readonly create: (variable: string, value: string | undefined) => Secret;
}

let access: SecretAccess | undefined;

/**
 * A secret value of the environment (#261): set only from a process variable with `secret("X")` — a
 * literal does not compile (the class has a private field), and a `Secret` is not a `string`. It
 * prints as `***`; only `.reveal()` gives the value.
 */
export class Secret {
  readonly #variable: string;
  readonly #value: string | undefined;

  static {
    access = {
      variableOf: (secret) => secret.#variable,
      isResolved: (secret) => secret.#value !== undefined,
      create: (variable, value) => new Secret(variable, value),
    };
  }

  private constructor(variable: string, value: string | undefined) {
    this.#variable = variable;
    this.#value = value;
  }

  /** The value itself — the only way to it; read it where it is used, never to store or print it. */
  reveal(): string {
    if (this.#value === undefined) {
      throw new EnvironmentError(
        EnvironmentErrorCode.NotFound,
        `the secret from ${this.#variable} is not resolved: read it from the application's environment, not from the environment file`,
      );
    }
    return this.#value;
  }

  toString(): string {
    return SECRET_MASK;
  }

  toJSON(): string {
    return SECRET_MASK;
  }

  [inspect.custom](): string {
    return SECRET_MASK;
  }
}

function secretAccess(): SecretAccess {
  if (access === undefined) throw new Error("unreachable: Secret's static block did not run");
  return access;
}

/** The process variable a secret is read from. */
export const variableOfSecret = (value: Secret): string => secretAccess().variableOf(value);

/** Whether a secret holds its value (resolved at start), or only names its variable. */
export const isResolvedSecret = (value: Secret): boolean => secretAccess().isResolved(value);

/** The secret of `variable` with its value, as the application's environment holds it. */
export const resolvedSecret = (variable: string, value: string): Secret =>
  secretAccess().create(variable, value);

/**
 * `databaseUrl: secret("DATABASE_URL")` — a `Secret` from a process variable, read when the app
 * starts; no default (a secret is never written in code).
 */
export const secret = (variable: string): Secret => secretAccess().create(variable, undefined);
