import { defineConfig } from "../../../../../src/config/define-config.js";
import { usd } from "../../../../../src/units/index.js";
import { ShelfSlotBudget } from "../shelves.application.js";

export default defineConfig({
  workflows: { "shelf-workflow": { budget: ShelfSlotBudget } },
  budgets: { "shelf-slot-budget": { maxSpend: usd(0.1) } },
});
