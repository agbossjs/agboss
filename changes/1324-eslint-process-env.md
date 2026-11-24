---
section: Breaking
issue: 1324
---

**`@agboss/core/eslint`: `AGBoss*` names, `agboss/no-process-env`, `agbossPlugin.configs.recommended`** (#1324):
`AgbossPlugin`, `AgbossRules` and `AgbossPluginMeta` are `AGBossPlugin`, `AGBossRules` and `AGBossPluginMeta`.
New rule `agboss/no-process-env` fails a raw `process.env` in a project's `src/` (`defineEnv` instead;
`processEnv: process.env` in an entry point and test files are allowed), `ProcessEnvMessageId` is exported, and
`agbossPlugin.configs.recommended` holds the flat-config blocks `agboss create` now spreads. `agboss/no-direct-time`
also flags `process.hrtime`. `agboss/no-component-state` lets the lifecycle hooks (`onInit`, `onReady`,
`onBeforeDestroy`, `onDestroy`) wire a field, and flags destructuring targets, `delete this.x` and `this.#x`.
Migration: rename the three types; replace a raw `process.env` read with a `defineEnv` field.
