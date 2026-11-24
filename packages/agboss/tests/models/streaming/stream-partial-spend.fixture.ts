import {
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
} from "../../../src/budgets/budget.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { bedrockApplicationOn } from "../transport/bedrock-apps.fixture.js";
import {
  STREAM_DESK,
  StreamSdkClient,
  StreamingModelProvider,
} from "./transport-streaming.fixture.js";

/** #1399: a streamed transport call that fails mid-way, on ample budgets and on a tight tenant one. */

@Budget({
  name: "partial-spend-tenant-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
})
export class PartialSpendTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.0001);
  }
}

export const PartialSpendApplication = bedrockApplicationOn({
  name: "stream-1399-application",
  desk: STREAM_DESK,
  providers: [StreamingModelProvider, StreamSdkClient],
});

export const PartialSpendTightApplication = bedrockApplicationOn({
  name: "stream-1399-tight-application",
  desk: STREAM_DESK,
  providers: [StreamingModelProvider, StreamSdkClient],
  budgets: [
    ...TEST_BUDGETS.filter((budget) => budget.name !== "TestTenantDailyBudget"),
    PartialSpendTenantBudget,
  ],
});
