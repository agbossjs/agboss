import { configureEnv, defineConfig } from "../../../../../src/index.js";
import { appEnv } from "../app.env.js";

export default defineConfig({
  env: [configureEnv(appEnv, { retries: 1 })],
  modelProviders: { "config-models": { model: "economy/default" } },
});
