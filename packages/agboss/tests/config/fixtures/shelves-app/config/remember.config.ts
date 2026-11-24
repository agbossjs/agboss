import { defineConfig } from "../../../../../src/index.js";
import { hours } from "../../../../../src/units/index.js";

/** The memory kept two hours, its readers seeing one turn in full. */
export default defineConfig({
  memories: { "shelf-memory": { ttl: hours(2), uncompactedTurns: 1 } },
});
