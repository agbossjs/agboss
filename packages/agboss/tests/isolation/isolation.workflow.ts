import { Window2Memory } from "../helpers/window-memory.js";
import {
  Agent,
  ExecutionContext,
  Injectable,
  Workflow,
  WorkflowSettings,
  type WorkflowDefinition,
  PiiAction,
  Tool,
  Ttl,
} from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { usd, type Usd } from "../../src/units/index.js";
import {
  ApprovalDesk,
  ChatAppChannel,
  ChatAppToolApproval,
  ChatStart,
  Reply,
} from "../channels/approval.workflow.js";
import { onStart } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS, TestApplicationDailyBudget } from "../flow/fixtures/budgets.js";
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "../../src/budgets/budget.js";
import { SharedExecutionRecordRepository } from "../helpers/shared-infrastructure.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

/** What the payment tool got: the owner of each call (`executionContext.ownerId`) and the cards charged. */
@Injectable()
export class PaymentLog {
  readonly owners: (string | undefined)[] = [];
  readonly cards: string[] = [];
}

class PayRequest {
  @Text({ prompt: "the order id" })
  orderId!: string;

  @Text({ prompt: "the card number", sensitive: PiiAction.mask({ keepLast: 4 }) })
  cardNumber!: string;
}

class PayDone {
  @Text()
  status!: string;
}

/** Charges a card — waits for an approval through the chat-app channel first. */
@Tool({
  name: "pay-tool",
  description: "Charges a card for an order",
  input: PayRequest,
  output: PayDone,
  approval: ChatAppToolApproval,
  deps: [PaymentLog, ExecutionContext],
})
export class Pay {
  constructor(
    private readonly log: PaymentLog,
    private readonly executionContext: ExecutionContext,
  ) {}

  execute({ orderId, cardNumber }: PayRequest): Promise<PayDone> {
    this.log.owners.push(this.executionContext.ownerId);
    this.log.cards.push(cardNumber);
    return Promise.resolve({ status: `paid ${orderId}` });
  }
}

@Agent({
  name: "cashier-agent",
  prompt: "./cashier.prompt.md",
  description: "Takes payments",
  model: "test/cashier",
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
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart)
    .toAgent(Cashier)
    .toFinish(Reply)],
  defaults,
  memory: Window2Memory,
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
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [Payments],
  channels: [ChatAppChannel],
  budgets: TEST_BUDGETS,
})
export class PaymentsApplication {}

/** The payments over a durable record repository: a restarted instance keeps the threads' owners. */
@Application({
  name: "durable-payments-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [Payments],
  channels: [ChatAppChannel],
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
  prompt: "./cashier.prompt.md",
  description: "Drafts",
  model: "test/drafter",
  input: { message: WorkflowStartTextDto },
  output: DraftDto,
})
export class Drafter {}

@Agent({
  name: "editor-agent",
  prompt: "./cashier.prompt.md",
  description: "Edits",
  model: "test/editor",
  input: { draft: DraftDto },
})
export class Editor {}

/** Two paid steps per execution: its own budget of $0.40, the tenant's $1.00 a day. */
@Workflow({
  name: "capped-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart)
    .toAgent(Drafter)
    .toAgent(Editor)
    .toFinish(Reply)],
  defaults,
  memory: Window2Memory,
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
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [Capped],
  budgets: [TestApplicationDailyBudget, CappedTenantDailyBudget, CappedExecutionBudget],
})
export class CappedApplication {}
