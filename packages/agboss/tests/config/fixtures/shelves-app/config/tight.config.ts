import { defineConfig } from "../../../../../src/index.js";
import { usd } from "../../../../../src/units/index.js";
import { ShelfOtherModels } from "../shelves.application.js";

/** Tighter limits for two budgets, and another provider and model for the router and the guardrail. */
export default defineConfig({
  budgets: {
    "shelf-attached-budget": { maxSpend: usd(0.5) },
    "shelf-listed-budget": { maxTokens: 50 },
  },
  guardrails: { "shelf-injection-guardrail": { model: "slow", modelProvider: ShelfOtherModels } },
  workflows: {
    "shelf-workflow": {
      routers: { "shelf-router": { model: "slow", modelProvider: ShelfOtherModels } },
    },
  },
});
