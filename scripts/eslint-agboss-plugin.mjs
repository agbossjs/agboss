// The repo's local lint rules as one plugin, `agboss/…`: one plugin object for every block that
// uses it (flat config refuses two objects under one plugin name).
import { noComponentState } from "./eslint-component-state.mjs";
import { noDirectTime } from "./eslint-direct-time.mjs";

const agbossPlugin = {
  rules: { "no-component-state": noComponentState, "no-direct-time": noDirectTime },
};

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
