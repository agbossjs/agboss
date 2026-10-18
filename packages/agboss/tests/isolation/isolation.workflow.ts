import {
  Agent,
  ExecutionContext,
  Injectable,
  Workflow,
  WorkflowSettings,
  type WorkflowDefinition,
  Tool,
  type ToolHandler,
} from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { usd } from "../../src/units/index.js";
import { ApprovalDesk, ChatAppChannel, ChatStart, Reply } from "../channels/approval.workflow.js";
import { start } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
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

  @Text({ prompt: "the card number", sensitive: true })
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
  history: { limit: 2 },
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
  channelClasses: [ChatAppChannel],
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

/** Two paid steps per run under a run cap of $0.40 and a daily cap of $1.00. */
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
})
export class Capped implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.4) }, perDay: { cost: usd(1) } })
      .build();
  }
}

@Application({
  name: "capped-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Capped],
  budgets: TEST_BUDGETS,
})
export class CappedApplication {}

/** A daily cap with no run cap: refused at start (#202). */
@Workflow({
  name: "day-cap-only-workflow",
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
})
export class DayCapOnly implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perDay: { cost: usd(1) } })
      .build();
  }
}

@Application({
  name: "day-cap-only-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DayCapOnly],
  budgets: TEST_BUDGETS,
})
export class DayCapOnlyApplication {}
