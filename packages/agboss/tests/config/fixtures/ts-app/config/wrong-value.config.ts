import { defineConfig } from "../../../../../src/index.js";

export default defineConfig({
  workflows: { "ts-workflow": { agents: { "ts-agent": { temperature: "hot-secret-value" } } } },
} as never);
