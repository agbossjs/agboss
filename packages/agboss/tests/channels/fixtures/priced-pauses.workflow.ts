import {
  Agent,
  EmptyEnvironment,
  Injectable,
  listOf,
  SpendRecorder,
  Tool,
  Workflow,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingCostLedger } from "../../helpers.js";
import {
  BatchWorkflowFinish,
  BatchWorkflowStart,
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  PauseLog,
  RefundDoneDto,
  RefundRequestDto,
  RefundTool,
  SeenPausedExecutionRepository,
} from "./pauses.workflow.js";

/**
 * #267 spend while several agent loops are paused: each branch pays for a lookup (a paid service,
 * `SpendRecorder`) before its refund pauses, so the paused execution's spend and the budget ledger
 * hold what every paused loop spent.
 */

/** What one lookup costs. */
export const LOOKUP_COST = 0.01;

/** Prices an order: a paid service, counted in the call's spend. */
@Tool({
  name: "price_order",
  description: "Prices an order",
  input: RefundRequestDto,
  output: RefundRequestDto,
  deps: [SpendRecorder],
})
export class PriceOrderTool implements ToolHandler<RefundRequestDto, RefundRequestDto> {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  run(input: RefundRequestDto): Promise<RefundRequestDto> {
    this.spendRecorder.record({ service: "order-api", cost: usd(LOOKUP_COST) });
    return Promise.resolve(input);
  }
}

@Agent({
  name: "priced-refund-agent",
  description: "Prices one order, then refunds it",
  prompt: "Price the order, then refund it.",
  model: "moonshotai/kimi-k2.6",
  tools: [PriceOrderTool, RefundTool],
  input: { request: RefundRequestDto },
  output: RefundDoneDto,
})
export class PricedRefundAgent {}

const ledgers: SeenCostLedgerRepository[] = [];

/** The application's ledger, seen by the tests: every record it counted. */
@Injectable()
export class SeenCostLedgerRepository extends RecordingCostLedger {
  constructor() {
    super();
    ledgers.push(this);
  }
}

/** The ledger of the test's latest application. */
export function costLedger(): SeenCostLedgerRepository {
  const ledger = ledgers.at(-1);
  if (ledger === undefined) throw new Error("the application has not started");
  return ledger;
}

@Workflow({
  name: "priced-batch-workflow",
  version: "1.0.0",
  maxSteps: 20,
  flow: [
    start(BatchWorkflowStart)
      .returns(listOf(RefundRequestDto))
      .toParallelAgents(PricedRefundAgent, { maxConcurrency: 3, maxItems: 5 })
      .join()
      .returns(listOf(RefundDoneDto))
      .toFinish(BatchWorkflowFinish),
  ],
})
export class PricedBatchWorkflow {}

@Application({
  name: "priced-pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PricedBatchWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
    SeenCostLedgerRepository,
  ],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PricedPausesApplication {}
