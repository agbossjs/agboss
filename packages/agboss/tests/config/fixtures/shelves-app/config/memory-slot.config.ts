import { defineConfig } from "../../../../../src/index.js";
import { ShelfOtherMemory } from "../shelves.application.js";

export default defineConfig({
  workflows: { "shelf-workflow": { memory: ShelfOtherMemory } },
  memories: { "shelf-other-memory": { uncompactedTurns: 2 } },
});
