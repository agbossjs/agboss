import { defineConfig } from "../../../../../src/config/define-config.js";
import { ShelfWorkflow } from "../shelves.application.js";

export default defineConfig({
  workflows: { "shelf-workflow": { budget: ShelfWorkflow } },
});
