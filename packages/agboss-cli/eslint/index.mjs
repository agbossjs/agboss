// The AGBoss lint rules (#388): one plugin, `agboss/…`, used by this repository's own ESLint config
// (scripts/eslint-agboss-plugin.mjs) and by the config `agboss create` writes into a project
// (templates/project/eslint.config.js.tmpl) — the only two importers; not a documented entry of
// agboss-cli. Plain JavaScript with no imports, so a project loads it from the installed CLI.
import { noComponentState } from "./no-component-state.mjs";
import { noDirectTime } from "./no-direct-time.mjs";

/** The plugin: one object for every config block that uses it (flat config refuses two). */
export const agbossPlugin = {
  meta: { name: "agboss" },
  rules: { "no-component-state": noComponentState, "no-direct-time": noDirectTime },
};

/**
 * One call per line in flow chains (#289): a chain of two calls or more has one call per line —
 * `@stylistic/newline-per-chained-call`, on for every `*.workflow.ts`.
 */
export const FLOW_CHAIN_RULE = {
  "@stylistic/newline-per-chained-call": ["error", { ignoreChainWithDepth: 1 }],
};
