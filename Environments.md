# Environments

The application's own settings (#261): one set per application, in `environments/` next to the
application file; workflows have none. The same code and the same `providers` run in every
environment — only values differ (dev / prod parity, 12-factor).

```
src/
  audit.application.ts          @Application({ environment: AppEnvironment, … })
  environments/
    app.environment.ts          the contract: a class with declared fields only
    dev.environment.ts          export const environment: AppEnvironment = { … }
    test.environment.ts         what tests run on
    prod.environment.ts         --env prod
```

## The contract

A plain class with declared fields only, declared once in the application — like the contexts:

```ts file=src/environments/app.environment.ts
// environments/app.environment.ts — the contract: fields only, no values
import type { Secret } from "agboss";

export class AppEnvironment {
  auditUrl!: string;
  databaseUrl!: Secret;
  port!: number;
  debug!: boolean;
}
```

<!-- snippet-context
import { Application, Budget, BudgetScope, Workflow, WorkflowFinish, WorkflowStart, start, type BudgetHandler } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { usd, type Usd } from "agboss/units";
@WorkflowStart({ name: "audit-workflow-start", description: "A request", input: WorkflowStartTextDto })
export class AuditWorkflowStart {}
@WorkflowFinish({ name: "audit-workflow-finish", description: "The request, as is", output: WorkflowStartTextDto })
export class AuditWorkflowFinish {}
@Workflow({
  name: "audit-workflow",
  version: "1.0.0",
  flow: [
    start(AuditWorkflowStart)
      .returns(WorkflowStartTextDto)
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
import { AppEnvironment } from "./environments/app.environment.js";

@Application({
  name: "audit-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [AuditWorkflow],
  budgets: [AuditExecutionBudget],
})
export class AuditApplication {}
```

- **No values in the contract.** The environments are object literals, not instances, so a value in
  a field (`auditUrl: string = "…"`) would be silently ignored — it fails assembly (`createApp`,
  `testWith`, `agboss check`): `[environment.contract-value] AppEnvironment.auditUrl has a value —
  the contract declares fields only; put the value in each environment`. A default is
  `env("X", { default })` in an environment; a value that may be missing is an optional field
  (`region?: string`) read with `env.optional("X")`.
- **Fields of the framework's own implementations** (`sqlitePath`, `langfusePublicKey`, …) are written
  by the project in its contract; nothing is added implicitly. A listed implementation whose field
  is missing fails assembly: `[environment.missing-field] SqliteExecutionRecordRepository needs
  sqlitePath: string in AppEnvironment` (the SQLite implementations come with #265).
- `environment` is required: an application with no settings declares the framework's empty
  contract, `@Application({ environment: EmptyEnvironment })` (any contract without fields works the
  same), and needs no environment file — its `dev` and `test` are `{}`. (An untyped caller without one gets an empty environment.)

## The environments

One plain object per environment, typed by the contract, in `environments/<name>.environment.ts` —
the file name is the environment's name (`--env prod` → `prod.environment.ts`):

```ts file=src/environments/prod.environment.ts
import { env, secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  auditUrl: env("AUDIT_URL"), // a string from a process variable, read when the app starts
  databaseUrl: secret("DATABASE_URL"), // a Secret: only from a process variable, no default
  port: env.integer("PORT", { default: 8080 }),
  debug: env.flag("DEBUG", { default: false }), // true / false / 1 / 0
};
```

```ts file=src/environments/dev.environment.ts
import { secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  auditUrl: "http://localhost:4000", // a value in the file
  databaseUrl: secret("DATABASE_URL"), // .env: pglite://memory — dev without Docker, same code
  port: 8080,
  debug: true,
};
```

```ts file=src/environments/test.environment.ts
import { secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  auditUrl: "http://audit.test", // a host no test reaches
  databaseUrl: secret("DATABASE_URL"), // set in the test process (CI, vitest env): :memory:
  port: 0,
  debug: true,
};
```

- A field missing in an environment, a mistyped one (`env("PORT")` in a `number` field) or one the
  contract lacks does not compile.
- There are no wrappers: no `declare module`, no `export default`, no `defineEnvironment` /
  `fromEnv`.
- `env("X")` / `env.integer("X")` / `env.flag("X")` are typed as the value they stand for; the
  framework replaces each with the variable's value at start. A variable set to a value of the wrong
  type (`PORT=soon`) fails the start: `PORT is not an integer (AppEnvironment.port, prod)`
  (`environment.invalid-value`).
- **Optional variables (#266 S90):** `env.optional("X")`, `env.integer.optional("X")` and
  `env.flag.optional("X")` are typed `string | undefined`, `number | undefined`,
  `boolean | undefined`, for an optional field of the contract. An unset (or empty) variable is
  `undefined` — not a missing variable, the start goes on — and a set one is still checked
  (`PORT=soon` fails as above). `agboss check --env <name>` marks it `value (optional)`,
  `agboss describe` shows an unset one as `<unset X, optional>`. Use it where the reader has its own
  default, such as a provider's base URL (below), so the default is not repeated.

## Choosing one

- `createApp(AuditApplication, { env: "prod" })`, `--env prod` on every workflow command; the default
  is `dev`.
- **Tests run on `test`**: `testWith(AuditApplication)` loads `test.environment.ts`, and without it
  the test fails, saying to create it — a test never reaches dev's addresses by accident.
  `testWith(AuditApplication, { env: "dev" })` names another; there is no option that passes values.
- An unknown name fails at once, listing the environments (`Available: dev, prod, test`).
- A process variable missing at start fails it naming the variable, the field and the environment —
  never a value — every missing one at once: `DATABASE_URL is not set (AppEnvironment.databaseUrl,
  prod)` (`environment.missing-variables`).

## Reading it

`agboss check` writes `interface Environment extends AppEnvironment {}` into `.agboss/types.d.ts`,
so `applicationContext.environment` gives the values typed by the contract (#261 PR 3 — there is no
separate environment token; the chosen environment's name is `applicationContext.environmentName`).
Components read it through the constructor (`deps: [ApplicationContext]`), never `process.env`:

```ts file=src/services/audit-store.service.ts
import { ApplicationContext, Injectable } from "agboss";

@Injectable({ deps: [ApplicationContext] })
export class AuditStoreService {
  constructor(private readonly applicationContext: ApplicationContext) {}

  connectionString(): string {
    return this.applicationContext.environment.databaseUrl.reveal(); // the only way to the value
  }
}
```

The values are frozen.

## Secrets

- A secret is a field of type `Secret`; its value comes **only** from a process variable
  (`secret("DATABASE_URL")`). A literal in a `Secret` field does not compile, and a `Secret` passed
  where a `string` is expected does not compile — so a secret is never hardcoded.
- A `Secret` prints as `***` everywhere it could be printed — `String(…)`, template strings, logs
  (`util.inspect`), JSON (traces), `agboss describe`, error messages; only an explicit `.reveal()`
  gives the value.
- **Secrets are process variables, and only that.** In Cloud Run a Secret Manager secret is bound to
  the variable at deploy (`gcloud run deploy … --set-secrets=DATABASE_URL=database-url:3`) and
  resolved when the instance starts; the framework calls no cloud SDK and nothing over the network
  for this — the same code runs locally (`.env`), in CI, Cloud Run and Kubernetes.
- **Model provider keys are secrets of the environment too** (#266 PR 2): a `@ModelProvider` names
  the field that holds its key — `apiKey: "openRouterApiKey"`, the built-ins read `openRouterApiKey`
  — and every environment that calls models sets it, `openRouterApiKey: secret("OPENROUTER_API_KEY")`.
  Tests script or replay models, so the contract may declare it optional
  (`openRouterApiKey?: Secret`) and `test.environment.ts` leave it out. A missing key fails the
  start of an app that calls the provider, naming the field
  ([Model providers](Model-providers#the-key-and-the-name)). A provider's **base URL** is read the
  same way: `baseUrlField: "openRouterBaseUrl"` names a text field, declared without a default
  (`openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")`): unset → the provider's `baseUrl`. There is no second way: `env()` / `secret()` in an environment
  are the only readers of process variables (`EnvironmentVariable` is removed, #266).
- **`agboss check` reads the contract's shape, not its secrets**: without `--models` a secret whose
  variable is unset is no problem — writing types and checking the assembly need no key, so
  `npm run types` (`postinstall`) works on a fresh `npm install`. `--models` connects to the
  providers, so it needs the secrets: a missing one fails, naming its variable
  (`OPENROUTER_API_KEY is not set (AppEnvironment.openRouterApiKey, dev)`). Every other variable
  is checked either way.

## The PII key

The application's PII key (#120) is a `Secret` field of the environment, named by
`@Application({ pseudonymKey: "piiPseudonymKey" })`, the same pattern as a model provider's
`apiKey`. Each environment sets it, for example `piiPseudonymKey: secret("PII_PSEUDONYM_KEY")`.

- **What uses it:** the `replaceWithToken()` HMAC of `sensitive` fields, of a project's own
  detectors (`PiiPolicyHandler`) and of every `@PiiPolicy` without its own `pseudonymKey`.
- **Why it is shared:** every instance uses the same key, so one value gets one token on every
  machine, and logs and traces from different machines match.
- **Precedence:** a policy's own `pseudonymKey` wins.
- **Assembly check:** a `pseudonymKey` field the contract does not declare fails assembly with
  `[environment.missing-field]`.
- **At start:**
  - A policy that needs the key when it is not set fails the start, naming the field and the
    policies.
  - When nothing needs the key and it is not set, `sensitive` fields and the policies without
    their own key use a key **of the instance** (S94): the start goes on, with the warning
    `[application.pii-instance-key]` in `app.warnings` and the start log — an error under
    `agboss check --strict`, silent in tests. Reveal still works (the token map is the execution's
    `piiTokens`, in the checkpoint); only one value gets another token on each instance, so logs
    and traces of several instances compare only with the application's key.
  - `testWith` uses a fixed test key when the variable is unset (no warning).
- **Tests and the optional field:** declare it optional (`piiPseudonymKey?: Secret`) and leave it out
  of `test.environment.ts`, as a model provider's key; `flow-patterns` does so.

See [Guards → PII policies](Guards#pii-policies).

## The CLI

| Command                                         | What it does with the environment                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `agboss check --workflow <path>`                | resolves the selected environment (default `dev`) and creates what the start creates     |
| `agboss check --workflow <path> --env prod`     | also lists the process variables `prod` needs, each marked `value` / `secret`             |
| `agboss describe --workflow <path> [--env <n>]` | shows the fields: literals, values, `*** (DATABASE_URL)`, `<missing AUDIT_URL>` — no keys |

```
environment prod: process variables
  AUDIT_URL  value → auditUrl
  DATABASE_URL  secret → databaseUrl
  PORT  value (has a default) → port
  DEBUG  value (has a default) → debug
```

Related: [Configuration](Configuration) (the `defaults` cascade), [App](App) (`createApp` options),
[Testing](Testing).
