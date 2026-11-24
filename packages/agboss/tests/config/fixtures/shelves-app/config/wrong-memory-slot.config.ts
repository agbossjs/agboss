import { defineConfig } from "../../../../../src/index.js";
import { ShelfWorkflow } from "../shelves.application.js";

export default defineConfig({
  workflows: { "shelf-workflow": { memory: ShelfWorkflow } },
});
