import { Window4Memory } from "../helpers/window-memory.js";
import {
  Agent,
  Workflow,
  TokenLimit,
  Tool,
  WorkflowFinish,
  WorkflowStart,
  Budget,
  BudgetScope,
  type BudgetHandler,
  BudgetExceededError,
  LimitExceededError,
  inline,
  Ttl,
} from "../../src/index.js";
import { OwnerToolApproval } from "../flow/fixtures/owner-approval.fixture.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { usd, type Usd } from "../../src/units/index.js";
import { onStart, toFinish } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

export class Payment {
  @Text() item!: string;
}

export class Receipt {
  @Text() id!: string;
}

/** What the buyer bought: the checker reads it. */
export class PurchaseDto {
  @Text({ prompt: "what was bought" })
  item!: string;
}

/** A tool that needs a person's approval: the run pauses before it runs. */
@Tool({
  name: "pay-tool",
  description: "Pays for an item",
  input: Payment,
  output: Receipt,
  approval: OwnerToolApproval,
})
export class Pay {
  execute({ item }: Payment): Promise<Receipt> {
    return Promise.resolve({ id: `receipt-${item}` });
  }
}

const price = { inputPerMTok: 1, outputPerMTok: 10 };
const defaults = {
  models: { temperature: 0, maxTokens: TokenLimit.ModelMax, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 4 },
} as const;

@Agent({
  name: "buyer-agent",
  prompt: inline("Buy what is asked."),
  description: "Buys things",
  model: "test/buyer",
  price,
  tools: [Pay],
  input: { message: WorkflowStartTextDto },
  output: PurchaseDto,
})
export class Buyer {}

@Agent({
  name: "checker-agent",
  prompt: inline("Check the purchase."),
  description: "Checks purchases",
  model: "test/checker",
  price,
  input: { purchase: PurchaseDto },
})
export class Checker {}

@WorkflowStart({
  name: "order-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class Order {}

@WorkflowFinish({
  name: "done-workflow-finish",
  description: "Bought and checked",
  output: WorkflowFinishTextDto,
})
export class Done {}

@WorkflowFinish({
  name: "over-budget-workflow-finish",
  description: "Out of money: what was bought",
  output: PurchaseDto,
})
export class OverBudget {}

/** An execution budget of $0.01: a buyer that spends more leaves nothing for the checker. */
@Budget({ name: "shop-execution-budget", scope: BudgetScope.Execution })
export class ShopExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.01);
  }
}

const SHOP_BUDGETS = [TestApplicationDailyBudget, TestTenantDailyBudget, ShopExecutionBudget];

@Workflow({
  name: "shop-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(Order)
      .toAgent(Buyer)
      .toAgent(Checker)
      .onError(BudgetExceededError, toFinish(OverBudget))
      .toFinish(Done),
  ],
  defaults,
  memory: Window4Memory,
})
export class Shop {}

@Application({
  name: "shop-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Shop],
  budgets: SHOP_BUDGETS,
})
export class ShopApplication {}

/** The same shop, catching the parent class: a budget error is a limit error. */
@Workflow({
  name: "shop-limits-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(Order)
      .toAgent(Buyer)
      .toAgent(Checker)
      .onError(LimitExceededError, toFinish(OverBudget))
      .toFinish(Done),
  ],
  defaults,
  memory: Window4Memory,
})
export class ShopCatchingLimits {}

@Application({
  name: "shop-limits-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ShopCatchingLimits],
  budgets: SHOP_BUDGETS,
})
export class ShopCatchingLimitsApplication {}

/** No catch: the budget error fails the run, typed. */
@Workflow({
  name: "shop-uncaught-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(Order)
      .toAgent(Buyer)
      .toAgent(Checker)
      .toFinish(Done),
  ],
  defaults,
  memory: Window4Memory,
})
export class ShopUncaught {}

@Application({
  name: "shop-uncaught-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ShopUncaught],
  budgets: SHOP_BUDGETS,
})
export class ShopUncaughtApplication {}
