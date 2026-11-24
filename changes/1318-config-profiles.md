---
section: Breaking
issue: 1318
---

**Profiles are `src/config/<name>.config.ts` and `<name>.config.yaml`, layered with `--profile a,b`** (#1318, part 1318d1).
One folder next to the file `@Application` is declared in replaces the root `profiles/<workflow>/<name>.yaml`
(and its `profileRoot`, which was the working directory); `base.config.*` is the shared layer under every
selection. `createApp(App, { profile })`, `testWith`, `studioOf`, `agboss run | chat | describe | check |
dev | studio | rag index | records export | eval | golden | compare` take the same selection — `"prod"`,
`"prod,economy"`, `"prod+economy"` or `["prod", "economy"]`, layered left to right, a later profile
winning per key — defaulting to `dev` (`createApp`, the CLI) and `test` (`testWith`).

- `defineConfig({ … })` (`@agboss/core`) is what a `.config.ts` exports: `env` (`configureEnv(appEnv, …)`
  values, one per `defineEnv`, which stays the only reader of the process's variables), `defaults`,
  `modelProviders` (a provider's `model` / `models` by its name), `workflows` (by name, `"*"` for every
  workflow first: `version`, `defaults`, `agents`, `compactions`, `prompts`) and the classes that stand in
  for the application's own (`modelProvider`, `storage`, `channels`, `observers`, `healthChecks`; a
  workflow's `modelProvider`). A `.config.yaml` holds the constants only: no `${ENV}`, no classes.
- The overlay is applied while the workflow is assembled, before its models resolve through the cascade
  (a role a profile names resolves like a declared one); the decorators' own options are never changed.
- Fails closed with a `ProfileError` (`reason`: `unknown`, `duplicate`, `bad-name`, `invalid`, `forbidden`):
  a profile that was named and has no file (the message lists the ones that exist; a default with no
  file is no layer), `<name>.config.ts` together with `<name>.config.yaml`, a name that is no profile
  name or is listed twice, a typo in a key, an agent, workflow or provider the application does not
  have, a YAML that holds `${…}`, a class, or a workflow's `memory` / `filePolicy` / `budget`. Messages
  name files and keys, never values.
- The project's `.env` is read from the folder of the `package.json` that holds the application (the
  CLI), no longer from the working directory.

Removed: `profileRoot` (`createApp`, `testWith`, `compareProfiles`), `withProfile` and `ProfileSchema` /
`loadProfile` / `applyProfile` / `profileFile` / `profilePrompts` / `profileJsonSchema`,
`schema/profile.schema.json` and `npm run schema`, the per-workflow `profiles/` folder. Added: `defineConfig`,
`ConfigSpec`, `ConfigOverlay`, `WorkflowConfig`, `ModelProviderOverlay`, `ProfileSelection`, `ProfileErrorReason`.
`compareBundleProfiles` takes a function from a profile to its workflow instead of one bundle.
