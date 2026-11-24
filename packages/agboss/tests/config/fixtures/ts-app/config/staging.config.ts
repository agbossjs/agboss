import { configureEnv, defineConfig } from "../../../../../src/index.js";
import { appEnv } from "../app.env.js";

export default defineConfig({
  env: configureEnv(appEnv, { region: "us" }),
  modelProviders: { "config-models": { models: { fast: "staging/fast" } } },
  workflows: { "ts-workflow": { agents: { "ts-agent": { temperature: 0 } } } },
});
