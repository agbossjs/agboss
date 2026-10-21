import {
  Agent,
  ExecutionContext,
  Injectable,
  Workflow,
  WorkflowSettings,
  type WorkflowDefinition,
  PiiAction,
  Tool,
  type ToolHandler,
} from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { usd, type Usd } from "../../src/units/index.js";
import { ApprovalDesk, ChatAppChannel, ChatStart, Reply } from "../channels/approval.workflow.js";
import { start } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS, TestApplicationDailyBudget } from "../flow/fixtures/budgets.js";
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "../../src/budgets/budget.js";
import { SharedExecutionRecordRepository } from "../helpers/shared-infrastructure.js";
import { EmptyEnvironment } from "../../src/index.js";

/** What the payment tool got: the owner of each call (`executionContext.ownerId`) and the cards charged. */
@Injectable()
export class PaymentLog {
  readonly owners: (string | undefined)[] = [];
  readonly cards: string[] = [];
}

class PayRequest {
  @Text({ prompt: "the order id" })
  orderId!: string;

  @Text({ prompt: "the card number", sensitive: PiiAction.replacePart({ keepLast: 4 }) })
  cardNumber!: string;
}

class PayDone {
  @Text()
  status!: string;
}

/** Charges a card — waits for an approval through the chat-app channel first. */
@Tool({
  name: "pay",
  description: "Charges a card for an order",
  input: PayRequest,
  output: PayDone,
  channel: ChatAppChannel,
  deps: [PaymentLog, ExecutionContext],
})
export class Pay implements ToolHandler<PayRequest, PayDone> {
  constructor(
    private readonly log: PaymentLog,
    private readonly executionContext: ExecutionContext,
  ) {}

  run({ orderId, cardNumber }: PayRequest): Promise<PayDone> {
    this.log.owners.push(this.executionContext.ownerId);
    this.log.cards.push(cardNumber);
    return Promise.resolve({ status: `paid ${orderId}` });
  }
}

const price = { inputPerMTok: 1, outputPerMTok: 10 };

@Agent({
  name: "cashier-agent",
  promptUrls: ["./cashier.prompt.md"],
  description: "Takes payments",
  model: "test/cashier",
  price,
  tools: [Pay],
})
export class Cashier {}

const defaults = {
  models: { temperature: 0, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 2 },
} as const;

/** One agent whose card payment waits for an approval: threads, pauses and channel output. */
@Workflow({
  name: "payments-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Cashier)
      .toFinish(Reply),
  ],
  defaults,
  uncompactedTurns: 2,
  providers: [ApprovalDesk, PaymentLog],
})
export class Payments implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .build();
  }
}

@Application({
  name: "payments-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Payments],
  budgets: TEST_BUDGETS,
})
export class PaymentsApplication {}

/** The payments over a durable record repository: a restarted instance keeps the threads' owners. */
@Application({
  name: "durable-payments-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Payments],
  providers: [SharedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class DurablePaymentsApplication {}

/** The drafter's draft: the editor reads it. */
export class DraftDto {
  @Text({ prompt: "the draft" })
  text!: string;
}

@Agent({
  name: "drafter-agent",
  promptUrls: ["./cashier.prompt.md"],
  description: "Drafts",
  model: "test/drafter",
  price,
  input: { message: WorkflowStartTextDto },
  output: DraftDto,
})
export class Drafter {}

@Agent({
  name: "editor-agent",
  promptUrls: ["./cashier.prompt.md"],
  description: "Edits",
  model: "test/editor",
  price,
  input: { draft: DraftDto },
})
export class Editor {}

/** Two paid steps per execution: its own budget of $0.40, the tenant's $1.00 a day. */
@Workflow({
  name: "capped-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Drafter)
      .returns(DraftDto)
      .toAgent(Editor)
      .toFinish(Reply),
  ],
  defaults,
  uncompactedTurns: 2,
})
export class Capped {}

@Budget({ name: "capped-execution-budget", scope: BudgetScope.Execution, workflow: Capped })
export class CappedExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.4);
  }
}

@Budget({ name: "capped-tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class CappedTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Application({
  name: "capped-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Capped],
  budgets: [TestApplicationDailyBudget, CappedTenantDailyBudget, CappedExecutionBudget],
})
export class CappedApplication {}
