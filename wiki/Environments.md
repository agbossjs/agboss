# Environments

The application's own settings (#261, #1324): one `defineEnv` per application, in a `*.env.ts` file next to
the application file (`agboss create` writes `src/config/app.env.ts`); workflows have none. It names the process variables the application reads,
once, as `env(...)` and `secret(...)` references, and the framework resolves them when the application
starts. The same code and the same `providers` run in every profile — only values differ (dev / prod
parity, 12-factor).

```
src/
  audit.application.ts          @Application({ ... })
  audit.env.ts                  export const auditEnv = defineEnv({ ... })
  config/
    dev.config.ts               export default defineConfig({ env: configureEnv(auditEnv, { ... }) })
    test.config.ts              what tests run on
    prod.config.ts              profile "prod"
```

## The variables

`defineEnv` takes one reference per key. A reference is a value that is not read yet — it is the
variable's name, how to parse it and its default:

```ts file=src/audit.env.ts
// audit.env.ts — the process variables the application reads: references, never values
import { defineEnv, env, secret } from "@agboss/core";

export const auditEnv = defineEnv({
  auditUrl: env("AUDIT_URL"), // a string from a process variable, read when the app starts
  databaseUrl: secret("DATABASE_URL"), // a Secret: only from a process variable, no default
  port: env.integer("PORT", { default: 8080 }),
  debug: env.boolean("DEBUG", { default: false }), // true / false / 1 / 0
});
```

- `env("X")` is `env.text("X")`; the other readers are `env.integer`, `env.number`, `env.boolean`,
  `env.duration` (`30d`, `24h`, `15m`, `10s`), `env.ttl` (a duration or `forever`), `env.bytes`
  (`64kb`, `10mb`) and `env.usd`, each with `{ default }`. There is no `env.flag`: it is `env.boolean`.
- **Optional variables (#266 S90):** `env.optional("X")`, `env.integer.optional("X")` and
  `env.boolean.optional("X")` are typed `string | undefined`, `number | undefined`,
  `boolean | undefined`. An unset (or empty) variable is `undefined` — not a missing variable, the
  start goes on — and a set one is still checked (`PORT=soon` fails). `secret.optional("X")` is
  `Secret | undefined`. Use it where the reader has its own default, such as a provider's base URL,
  so the default is not repeated.
- The dictionary is frozen and method-free; a key `then`, `__proto__`, `constructor` or `prototype`
  does not compile. `auditEnv.databaseUrl` is itself the `SecretRef` a component option takes
  (`bearer(ref)` makes an `Authorization: Bearer` source from a secret).
- **The framework's own storage and providers read no key of it**: a driver's path, URL and keys are
  references of their own (`SqliteDriver({ path: env("AGBOSS_SQLITE_PATH") })`,
  `secret("OPENROUTER_API_KEY")`) read from the process when the application starts, so there is
  nothing to declare for them (#1313, #1321).

## Reading it

A component takes the resolved values with `deps: [auditEnv]`: the dictionary is a dependency token,
and the value injected is `InferEnv<typeof auditEnv>` — every key with the type its reference
stands for, a secret a `Secret`. Components read it through the constructor, never `process.env`
(the `agboss/no-process-env` lint rule):

<!-- snippet-context
import { Application, Budget, BudgetScope, Ttl, Workflow, WorkflowFinish, WorkflowStart, onStart, type BudgetHandler } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { usd, type Usd } from "@agboss/core/units";
@WorkflowStart({ name: "audit-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class AuditWorkflowStart {}
@WorkflowFinish({ name: "audit-workflow-finish", description: "The request, as is", output: WorkflowStartTextDto })
export class AuditWorkflowFinish {}
@Workflow({
  name: "audit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(AuditWorkflowStart)
      .toFinish(AuditWorkflowFinish),
  ],
})
export class AuditWorkflow {}
@Budget({ name: "audit-execution-budget", scope: BudgetScope.Execution })
export class AuditExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
// @snippet
-->

```ts file=src/audit.application.ts
@Application({
  name: "audit-application",
  version: "1.0.0",
  workflows: [AuditWorkflow],
  budgets: [AuditExecutionBudget],
})
export class AuditApplication {}
```

```ts file=src/services/audit-store.service.ts
import { Injectable, type InferEnv } from "@agboss/core";
import { auditEnv } from "../audit.env.js";

@Injectable({ deps: [auditEnv] })
export class AuditStoreService {
  constructor(private readonly settings: InferEnv<typeof auditEnv>) {}

  connectionString(): string {
    return this.settings.databaseUrl.reveal(); // the only way to the value
  }
}
```

The values are resolved once per container and frozen. In a test, `testApp.get(auditEnv)` returns what
the components got. `ApplicationContext` carries no settings: only `name`, `version`, `instanceId`,
`startedAt`, `profiles` and `host`.

## Choosing the values: profiles

The values of a deployment are a [profile](Configuration#profiles-srcconfig-1318): a file
`src/config/<name>.config.ts|yaml` next to the application file, which sets keys of the dictionary
with `configureEnv`. A key it leaves out is read from the process:

```ts file=src/config/dev.config.ts
import { configureEnv, defineConfig } from "@agboss/core";
import { auditEnv } from "../audit.env.js";

export default defineConfig({
  env: configureEnv(auditEnv, { auditUrl: "http://localhost:4000", port: 8080, debug: true }),
});
```

- `createApp(AuditApplication, { profile: "prod" })` — `"prod,economy"` or `["prod", "economy"]`
  layers profiles left to right, a later one wins per key. The default is `dev`; the CLI takes the same
  selection as `--profile <list>`. There is no environment name and no environment file.
- **Tests run on `test`**: `testWith(AuditApplication)` loads `test.config.ts` when it exists, and a
  profile the test names and that has no file fails, listing the ones that exist — a test never
  reaches dev's addresses by accident.
- A test may set a few variables itself: `testWith(AuditApplication, { env: configureEnv(auditEnv, {
  auditUrl: "http://audit.test" }) })`. The option takes only `configureEnv(...)` overrides, one or a
  list (one per `defineEnv`, so two dictionaries never collide on a key); `testModule` and the unit
  runners (`testUnit`) take the same. They win over the profile's and the process's values. The
  process-variable map itself is `processEnv`.
- A variable that is not set at start, or is set to a value of the wrong type, fails the start with
  `ConfigError.Environment` (`config.environment`): every problem at once, the message naming the
  rule, the variable and the key — never a value:
  `[environment.missing-variable] DATABASE_URL is not set (databaseUrl)`,
  `[environment.invalid-value] PORT is not an integer (port)`.

## Secrets

- A secret is a `secret("DATABASE_URL")` reference that resolves to a `Secret`; its value comes
  **only** from a process variable, with no default. A literal where a secret is expected does not
  compile, and a `Secret` passed where a `string` is expected does not compile — so a secret is never
  hardcoded.
- A `Secret` prints as `***` everywhere it could be printed — `String(…)`, template strings, logs
  (`util.inspect`), JSON (traces), `agboss describe`, error messages; only an explicit `.reveal()`
  gives the value.
- **Secrets are process variables, and only that.** In Cloud Run a Secret Manager secret is bound to
  the variable at deploy (`gcloud run deploy … --set-secrets=DATABASE_URL=database-url:3`) and
  resolved when the instance starts; the framework calls no cloud SDK and nothing over the network
  for this — the same code runs locally (`.env`), in CI, Cloud Run and Kubernetes.
- **Model provider keys are secrets of the driver, not keys of the application's `defineEnv`** (#1313): a
  `@ModelProvider`'s driver reads its key and base URL as references — `OpenRouterDriver({ apiKey:
  secret("OPENROUTER_API_KEY"), baseUrl: env("OPENROUTER_BASE_URL", { default: "…" }) })` — from the
  process when the application starts. A missing key fails the start of an app that calls the provider,
  naming the variable ([Model providers](Model-providers#drivers)); tests script or replay models and need
  none. There is no second way: `env()` / `secret()` (and `defineEnv`) are the only readers of process
  variables (`EnvironmentVariable` is removed, #266).
- **`agboss check` needs no secret and no variable**: it builds the application on placeholders (an
  unset required value is an empty text, `0`, `false`; a secret stays unresolved and fails at
  `reveal()`), so writing types and checking the assembly work on a fresh `npm install`
  (`postinstall`), and an unset variable is only reported as `not set`. `--strict` makes a required
  variable the process and the profile do not set fail; a secret only together with `--models`
  (`[environment.missing-variable] OPENROUTER_API_KEY is not set (apiKey)`); a variable set to a value
  its reference cannot read is `[environment.invalid-value]`.

## The PII key

The application's PII key (#120, #1301, #1321) is a `Secret` of its **database storage**:
`@DatabaseStorage({ piiSecret: secret("PII_PSEUDONYM_KEY") })` (rotated with `previousPiiSecret:
secret.optional("…")`), read from the process when the application starts — never a key of
`defineEnv`, never made up by an instance.

- **What uses it:** the `tokenize()` HMAC of `sensitive` fields, of a project's own detectors
  (`PiiPolicyHandler`) and of every `@PiiPolicy` without its own `secret`; every use has a key of its
  own, derived by HKDF ([Guards → the PII key hierarchy](Guards#the-pii-key-hierarchy)).
- **Why it is shared:** every instance uses the same key, so one value gets one token on every
  machine, and logs and traces from different machines match.
- **Precedence:** a policy's own `secret` wins.
- **Its variable is its own:** the variable of `piiSecret`, `previousPiiSecret`, `idempotencySecret` or
  `previousIdempotencySecret` may not be read by anything else the application holds — a model
  provider's `apiKey`, the mesh's `signingKey`, a PII policy's key, any other `secret(…)` / `env(…)`
  of a component, a driver or `deps: [defineEnv]` — `[storage.secret-shared]` at assembly: rotating a
  provider's key must never change every stored token and fingerprint. Two providers on one key are fine.
  A secret comes from the process only: a profile's `configureEnv` and a test's `env` refuse one.
- **At start:** a `tokenize()` rule or action, or a `sensitive: PiiAction.tokenize()` field, with no
  key to make its token fails the start with `[pii.secret-required]`, naming the policy or the
  `Dto.field` — no storage supplies one, `InMemoryDatabaseStorage` included. `mask()` needs no key.
- **Tests:** `testWith` has a fixed test key (refused under `NODE_ENV=production`), so a project's
  tests need no variable; `createApp` and the CLI never do.

See [Guards → PII policies](Guards#pii-policies) and [Upgrading to 0.1.1](Upgrading-to-0.1.1).

## The CLI

Each loads the application of `package.json` (`"agboss": { "application" }`, or `--application <path>`, [CLI](CLI#the-application-and-its-starts-268)) and takes the selection of profiles as `--profile <list>`.

| Command                      | What it does with the variables                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agboss check`               | creates what every workflow's start creates, on placeholders, and lists the process variables the application needs: names only, `value` / `secret`, `not set` where the process lacks one, never a value; `--strict` fails on a required one that is unset |
| `agboss describe`            | shows the application; a secret is masked as `***`, no keys                                           |

```
the application needs 4 process variables:
  AUDIT_URL     value
  DATABASE_URL  secret
  PORT          value, has a default
  DEBUG         value, has a default
```

It is the list for `--set-env-vars` / `--set-secrets` at deploy (#268): `has a default` and
`optional` may stay unset; the names in a secret manager are not known to the framework and are not
printed. The list is part of the [check report](CLI#the-check-report-268).

Related: [Configuration](Configuration) (profiles and the `defaults` cascade), [App](App) (`createApp` options),
[Testing](Testing).
