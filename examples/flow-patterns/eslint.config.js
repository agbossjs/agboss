// `npm run lint`: what a project made by `agboss create` lints with (#388) — typescript-eslint on the
// example's types and the rules AGBoss code follows, from `@agboss/core/eslint`. The repo's own gate
// lints the example too, with the same rules (its eslint.config.js at the root).
import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { FLOW_CHAIN_RULE, agbossPlugin } from "@agboss/core/eslint";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "coverage", ".agboss", "eval"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // a component is its decorator: @Agent, @WorkflowStart, … classes are empty on purpose
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
    },
  },
  {
    // a component keeps no state, and reads the time through the injected Clock
    files: ["src/**/*.ts"],
    plugins: { agboss: agbossPlugin },
    rules: { "agboss/no-component-state": "error", "agboss/no-direct-time": "error" },
  },
  {
    // one call per line in every chain of a workflow module
    files: ["**/*.workflow.ts"],
    plugins: { "@stylistic": stylistic },
    rules: FLOW_CHAIN_RULE,
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
