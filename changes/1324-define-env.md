---
section: Breaking
issue: 1324
---

**`defineEnv`** (#1324, part b, additive) — one reader of the process's variables: a frozen, method-free dictionary
of `env.*` / `secret(…)` references (`EnvRef<T>`, `SecretRef`, `OptionalSecretRef`) that is also a dependency token
(`deps: [appEnv]` injects `InferEnv<typeof appEnv>`, resolved when the application starts, every missing or
unparsable variable named at once and never its value). The readers: `env` (= `env.text`), `env.integer`,
`env.number`, `env.boolean`, `env.duration` (`30d`, `24h`), `env.ttl` (`forever`; `none` with `{ allowNone: true }`),
`env.bytes` (`64kb`, `10mb`), `env.usd`, each with `{ default }` and `.optional("VAR")`, and `secret.optional("VAR")`.
Also `configureEnv(appEnv, overrides)`, `bearer(secretRef)`, `ApplicationContext.profiles` and `Ttl`
(`Ttl.Forever`, `Ttl.None`) from the root and `@agboss/core/units`.

- **Added:** `defineEnv`, `configureEnv`, `bearer`, `EnvRef`, `SecretRef`, `OptionalSecretRef`, `InferEnv`,
  `EnvContract`, `env.text/number/boolean/duration/ttl/bytes/usd`, `secret.optional`, `Ttl`, `ApplicationContext.profiles`.
- **Renamed (types):** `EnvironmentValueOptions` → `EnvOptions`, `EnvironmentValueReader` → `EnvReader`,
  `EnvironmentVariableReader` → `EnvReaders`.
