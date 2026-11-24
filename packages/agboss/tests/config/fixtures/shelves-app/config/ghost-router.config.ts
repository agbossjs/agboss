import { defineConfig } from "../../../../../src/index.js";

export default defineConfig({
  workflows: { "shelf-workflow": { routers: { "ghost-router": { model: "slow" } } } },
});
