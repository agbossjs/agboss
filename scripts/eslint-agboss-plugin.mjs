// The AGBoss lint rules, `agboss/…`, for this repository: the public entry `@agboss/core/eslint` (#388 S2,
// packages/agboss/src/eslint), the same one a project made by `agboss create` loads — so the
// framework is built before it is linted (`make check` builds first).
import { agbossPlugin } from "@agboss/core/eslint";

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
