// The AGBoss lint rules, `agboss/…`, for this repository: the plugin ships with agboss-cli
// (packages/agboss-cli/eslint, #388), where a project made by `agboss create` loads it too.
import { agbossPlugin } from "../packages/agboss-cli/eslint/index.mjs";

/** `agboss/no-component-state` (#261): framework sources and examples. */
export const componentStateRules = {
  files: ["packages/agboss/src/**/*.ts", "examples/*/src/**/*.ts"],
  plugins: { agboss: agbossPlugin },
  rules: { "agboss/no-component-state": "error" },
};

/** `agboss/no-direct-time` (#262): framework sources, the real Clock implementation excepted. */
export const directTimeRules = {
  files: ["packages/agboss/src/**/*.ts"],
  ignores: ["packages/agboss/src/infrastructure/clock.ts"],
  plugins: { agboss: agbossPlugin },
  rules: { "agboss/no-direct-time": "error" },
};
