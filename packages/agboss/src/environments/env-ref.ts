import type { Secret } from "./secret.js";

declare const envRefBrand: unique symbol;
declare const secretRefBrand: unique symbol;
declare const optionalSecretRefBrand: unique symbol;
declare const envContractBrand: unique symbol;

/**
 * A value `defineEnv` reads from a process variable at start (#1324): `env.duration("DEADLINE")` is an
 * `EnvRef<Milliseconds>`. A component option that takes one (`maxSpend: Usd | EnvRef<Usd>`) reads it
 * where it is used; the framework resolves it once, when the application starts.
 */
export interface EnvRef<T> {
  readonly [envRefBrand]: T;
  /** The process variable it is read from. */
  readonly variable: string;
}

/** A `Secret` `defineEnv` reads from a process variable (`secret("API_KEY")`); no default. */
export interface SecretRef {
  readonly [secretRefBrand]: true;
  readonly variable: string;
}

/** A `Secret` that may be unset (`secret.optional("API_KEY")`): `Secret | undefined` once resolved. */
export interface OptionalSecretRef {
  readonly [optionalSecretRefBrand]: true;
  readonly variable: string;
}

/** What `defineEnv` takes: one reference per key. */
export type EnvSpec = Readonly<Record<string, EnvRef<unknown> | SecretRef | OptionalSecretRef>>;

/** What a key of a spec resolves to: the value of an `EnvRef<T>`, a `Secret`, a maybe-`Secret`. */
export type InferEnvValue<TRef> = TRef extends SecretRef
  ? Secret
  : TRef extends OptionalSecretRef
    ? Secret | undefined
    : TRef extends EnvRef<infer TValue>
      ? TValue
      : never;

/** The resolved values of a `defineEnv`, by key: `InferEnv<typeof appEnv>`. */
export type InferEnv<TContract> = TContract extends { readonly [envContractBrand]: infer TSpec }
  ? { readonly [TKey in keyof TSpec]: InferEnvValue<TSpec[TKey]> }
  : never;

/**
 * What `defineEnv` returns: a method-free dictionary of the references it was given — `appEnv.apiKey` is
 * the `SecretRef` — and a dependency token: `deps: [appEnv]` injects its resolved values.
 */
export type EnvContract<TSpec extends EnvSpec = EnvSpec> = TSpec & {
  readonly [envContractBrand]: TSpec;
};

/** Keys a dictionary of the environment cannot have: `then` would make it a thenable. */
export type ReservedEnvKey = "then" | "__proto__" | "constructor" | "prototype";
