import {
  Agent,
  Workflow,
  MODEL_MAX,
  Tool,
  type ToolHandler,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
  BudgetExceededError,
  LimitExceededError,
} from "../../src/index.js";
import { TerminalUserChannel } from "../../src/channels/terminal-channel.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { usd } from "../../src/units/index.js";
import { start, toFinish } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

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
  name: "pay",
  description: "Pays for an item",
  input: Payment,
  output: Receipt,
  channel: TerminalUserChannel,
})
export class Pay implements ToolHandler<Payment, Receipt> {
  run({ item }: Payment): Promise<Receipt> {
    return Promise.resolve({ id: `receipt-${item}` });
  }
}

const price = { inputPerMTok: 1, outputPerMTok: 10 };
const defaults = {
  models: { temperature: 0, maxTokens: MODEL_MAX, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 4 },
  history: { limit: 4 },
} as const;

@Agent({
  name: "buyer-agent",
  prompt: "Buy what is asked.",
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
  prompt: "Check the purchase.",
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

/** A run budget of $0.01: a buyer that spends more leaves nothing for the checker. */
const settings = (): WorkflowSettings =>
  WorkflowSettings.builder()
    .limits({ perRun: { cost: usd(0.01) } })
    .build();

@Workflow({
  name: "shop-workflow",
  version: "1.0.0",
  flow: [
    start(Order)
      .returns(WorkflowStartTextDto)
      .toAgent(Buyer)
      .returns(PurchaseDto)
      .toAgent(Checker)
      .onError(BudgetExceededError, toFinish(OverBudget))
      .toFinish(Done),
  ],
  defaults,
  channelClasses: [TerminalUserChannel],
})
export class Shop implements WorkflowDefinition {
  settings = settings;
}

@Application({
  name: "shop-application",
  version: "1.0.0",
  workflows: [Shop],
  budgets: TEST_BUDGETS,
})
export class ShopApplication {}

/** The same shop, catching the parent class: a budget error is a limit error. */
@Workflow({
  name: "shop-limits-workflow",
  version: "1.0.0",
  flow: [
    start(Order)
      .returns(WorkflowStartTextDto)
      .toAgent(Buyer)
      .returns(PurchaseDto)
      .toAgent(Checker)
      .onError(LimitExceededError, toFinish(OverBudget))
      .toFinish(Done),
  ],
  defaults,
  channelClasses: [TerminalUserChannel],
})
export class ShopCatchingLimits implements WorkflowDefinition {
  settings = settings;
}

@Application({
  name: "shop-limits-application",
  version: "1.0.0",
  workflows: [ShopCatchingLimits],
  budgets: TEST_BUDGETS,
})
export class ShopCatchingLimitsApplication {}

/** No catch: the budget error fails the run, typed. */
@Workflow({
  name: "shop-uncaught-workflow",
  version: "1.0.0",
  flow: [
    start(Order)
      .returns(WorkflowStartTextDto)
      .toAgent(Buyer)
      .returns(PurchaseDto)
      .toAgent(Checker)
      .toFinish(Done),
  ],
  defaults,
  channelClasses: [TerminalUserChannel],
})
export class ShopUncaught implements WorkflowDefinition {
  settings = settings;
}

@Application({
  name: "shop-uncaught-application",
  version: "1.0.0",
  workflows: [ShopUncaught],
  budgets: TEST_BUDGETS,
})
export class ShopUncaughtApplication {}
