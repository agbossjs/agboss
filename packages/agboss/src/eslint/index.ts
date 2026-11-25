// `@agboss/core/eslint` (#388 S2): the lint rules AGBoss code follows, for a project's ESLint flat config —
// the one `agboss create` writes imports it — and for this repository's own. A separate entry: the
// root import never loads it. The rules use `@typescript-eslint/utils`: an optional peer of
// `@agboss/core`, installed with `typescript-eslint` wherever this entry is loaded.
import type { TSESLint } from "@typescript-eslint/utils";
import { noComponentState, type ComponentStateMessageId } from "./no-component-state.js";
import { noDirectTime, type DirectTimeMessageId } from "./no-direct-time.js";
import { noInternalImport, type InternalImportMessageId } from "./no-internal-import.js";
import { noProcessEnv, type ProcessEnvMessageId } from "./no-process-env.js";

export type {
  ComponentStateMessageId,
  DirectTimeMessageId,
  InternalImportMessageId,
  ProcessEnvMessageId,
};

/**
 * The plugin's rules by name: `agboss/no-component-state`, `agboss/no-direct-time`,
 * `agboss/no-internal-import`, `agboss/no-process-env` — a record of rules, as a typed ESLint config (`tseslint.config`) takes a plugin's.
 */
export interface AGBossRules extends Readonly<Record<string, TSESLint.LooseRuleDefinition>> {
  /** `this.x = …` outside the constructor of a component (#261). */
  readonly "no-component-state": TSESLint.RuleModule<ComponentStateMessageId>;
  /** `Date.now()`, `new Date()`, timers — the application's `Clock` instead (#262). */
  readonly "no-direct-time": TSESLint.RuleModule<DirectTimeMessageId>;
  /** An import of `@agboss/core/internal` — the CLI's, no semver promise (#818). */
  readonly "no-internal-import": TSESLint.RuleModule<InternalImportMessageId>;
  /** A raw `process.env` — `defineEnv` instead (#1324). */
  readonly "no-process-env": TSESLint.RuleModule<ProcessEnvMessageId>;
}

/** The plugin's identity, as ESLint reports it. */
export interface AGBossPluginMeta {
  /** `"agboss"`: the prefix of its rules. */
  readonly name: string;
}

/** The plugin, registered as `agboss` in a config block: `plugins: { agboss: agbossPlugin }`. */
export interface AGBossPlugin {
  /** Its name. */
  readonly meta: AGBossPluginMeta;
  /** Its rules. */
  readonly rules: AGBossRules;
  /** Ready flat-config blocks: `...agbossPlugin.configs.recommended`. */
  readonly configs: { readonly recommended: readonly TSESLint.FlatConfig.Config[] };
}

const rules: AGBossRules = {
  "no-component-state": noComponentState,
  "no-direct-time": noDirectTime,
  "no-internal-import": noInternalImport,
  "no-process-env": noProcessEnv,
};

const meta: AGBossPluginMeta = { name: "agboss" };

/**
 * The AGBoss rules as one ESLint plugin — one object for every block that uses it. `configs.recommended`
 * is what `agboss create` writes: the state, time and environment rules for a project's `src/` (tests
 * excepted) and the internal-import rule for every file.
 */
export const agbossPlugin: AGBossPlugin = (() => {
  const blocks: TSESLint.FlatConfig.Config[] = [];
  const plugin: AGBossPlugin = { meta, rules, configs: { recommended: blocks } };
  // the blocks name this very object: ESLint refuses one plugin name bound to two objects
  blocks.push(
    {
      name: "agboss/recommended-src",
      files: ["src/**/*.ts"],
      ignores: ["src/**/*.test.ts", "src/**/*.spec.ts"],
      plugins: { agboss: plugin },
      rules: {
        "agboss/no-component-state": "error",
        "agboss/no-direct-time": "error",
        "agboss/no-process-env": "error",
      },
    },
    {
      name: "agboss/recommended-internal",
      files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
      plugins: { agboss: plugin },
      rules: { "agboss/no-internal-import": "error" },
    },
  );
  return plugin;
})();

/**
 * One call per line in flow chains (#289): `@stylistic/newline-per-chained-call` with the
 * framework's options — a chain of two calls or more has one call per line — for every
 * `*.workflow.ts` (`rules: FLOW_CHAIN_RULE`, with `@stylistic/eslint-plugin` as `@stylistic`).
 */
export const FLOW_CHAIN_RULE: TSESLint.Linter.RulesRecord = {
  "@stylistic/newline-per-chained-call": ["error", { ignoreChainWithDepth: 1 }],
};
