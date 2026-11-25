import { defineConfig } from "../../../../../src/index.js";

/** A budget that reads its limit in code takes none from a profile. */
export default defineConfig({ budgets: { "test-application-daily-budget": { maxTokens: 1 } } });
