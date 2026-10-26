// `@agboss/core/eslint` (#388 S2): the lint rules AGBoss code follows, for a project's ESLint flat config —
// the one `agboss create` writes imports it — and for this repository's own. A separate entry: the
// root import never loads it. The rules use `@typescript-eslint/utils`: an optional peer of
// `agboss`, installed with `typescript-eslint` wherever this entry is loaded.
import type { TSESLint } from "@typescript-eslint/utils";
import { noComponentState, type ComponentStateMessageId } from "./no-component-state.js";
import { noDirectTime, type DirectTimeMessageId } from "./no-direct-time.js";

export type { ComponentStateMessageId, DirectTimeMessageId };

/**
 * The plugin's rules by name: `agboss/no-component-state`, `agboss/no-direct-time` — a record of
 * rules, as a typed ESLint config (`tseslint.config`) takes a plugin's.
 */
export interface AgbossRules extends Readonly<Record<string, TSESLint.LooseRuleDefinition>> {
  /** `this.x = …` outside the constructor of a component (#261). */
  readonly "no-component-state": TSESLint.RuleModule<ComponentStateMessageId>;
  /** `Date.now()`, `new Date()`, timers — the application's `Clock` instead (#262). */
  readonly "no-direct-time": TSESLint.RuleModule<DirectTimeMessageId>;
}

/** The plugin's identity, as ESLint reports it. */
export interface AgbossPluginMeta {
  /** `"agboss"`: the prefix of its rules. */
  readonly name: string;
}

/** The plugin, registered as `agboss` in a config block: `plugins: { agboss: agbossPlugin }`. */
export interface AgbossPlugin {
  /** Its name. */
  readonly meta: AgbossPluginMeta;
  /** Its rules. */
  readonly rules: AgbossRules;
}

/** The AGBoss rules as one ESLint plugin — one object for every block that uses it. */
export const agbossPlugin: AgbossPlugin = {
  meta: { name: "agboss" },
  rules: { "no-component-state": noComponentState, "no-direct-time": noDirectTime },
};

/**
 * One call per line in flow chains (#289): `@stylistic/newline-per-chained-call` with the
 * framework's options — a chain of two calls or more has one call per line — for every
 * `*.workflow.ts` (`rules: FLOW_CHAIN_RULE`, with `@stylistic/eslint-plugin` as `@stylistic`).
 */
export const FLOW_CHAIN_RULE: TSESLint.Linter.RulesRecord = {
  "@stylistic/newline-per-chained-call": ["error", { ignoreChainWithDepth: 1 }],
};
