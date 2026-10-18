import { Application } from "../../../src/application/application.js";
import { Agent, Injectable, Workflow, WorkflowFinish, WorkflowStart } from "../../../src/index.js";
import type { OnInit } from "../../../src/components/container/lifecycle.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  CostLedgerRepository,
  type CostCounter,
} from "../../../src/infrastructure/cost-ledger.repository.js";
import { usd, type Usd } from "../../../src/units/index.js";
import type { UsageRecord } from "../../../src/finops/usage.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { testDefaults } from "../../helpers.js";
import { start } from "../../helpers/flow.js";
import { EmptyEnvironment } from "../../../src/index.js";

/**
 * #261 PR 2 — an application of two workflows: orders and refunds, each its own start; a service
 * both list (one instance for the application), and a ledger the application lists (its
 * infrastructure).
 */

/** What happened at start, in order (the tests reset it). */
export const started: string[] = [];

/** Listed by both workflows: one instance for the whole application. */
@Injectable()
export class DeskDirectoryService implements OnInit {
  constructor() {
    started.push("DeskDirectoryService.constructor");
  }

  onInit(): void {
    started.push("DeskDirectoryService.onInit");
  }
}

/** The application's cost ledger: every recorded spend kept, by the budgets it counts in. */
@Injectable()
export class RecordingCostLedgerRepository extends CostLedgerRepository {
  readonly saved: {
    readonly budgets: readonly string[];
    readonly records: readonly UsageRecord[];
  }[] = [];

  findSpentByCounter(): Promise<Usd> {
    return Promise.resolve(usd(0));
  }

  saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void> {
    this.saved.push({ budgets: counters.map((counter) => counter.budget), records });
    return Promise.resolve();
  }

  findMaxSpendByAccount(): Promise<Usd | undefined> {
    return Promise.resolve(undefined);
  }

  saveMaxSpend(): Promise<void> {
    return Promise.resolve();
  }
}

/** A workflow service that reads the application's ledger: it gets the listed implementation. */
@Injectable({ deps: [CostLedgerRepository] })
export class SpendReportService {
  constructor(readonly costLedgerRepository: CostLedgerRepository) {}
}

@WorkflowStart({
  name: "orders-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class OrdersWorkflowStart {}

@WorkflowFinish({
  name: "orders-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class OrdersWorkflowFinish {}

@Agent({
  name: "orders-agent",
  description: "Answers orders",
  prompt: "Answer.",
  model: "test/alpha",
})
export class OrdersAgent {}

@Workflow({
  name: "orders-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: [
    start(OrdersWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OrdersAgent)
      .toFinish(OrdersWorkflowFinish),
  ],
  providers: [DeskDirectoryService, SpendReportService],
})
export class OrdersWorkflow {}

@WorkflowStart({
  name: "refunds-workflow-start",
  description: "A refund",
  input: WorkflowStartTextDto,
})
export class RefundsWorkflowStart {}

@WorkflowFinish({
  name: "refunds-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class RefundsWorkflowFinish {}

@Agent({
  name: "refunds-agent",
  description: "Answers refunds",
  prompt: "Answer.",
  model: "test/beta",
})
export class RefundsAgent {}

@Workflow({
  name: "refunds-workflow",
  version: "2.0.0",
  defaults: testDefaults,
  flow: [
    start(RefundsWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(RefundsAgent)
      .toFinish(RefundsWorkflowFinish),
  ],
  providers: [DeskDirectoryService],
})
export class RefundsWorkflow {}

@Application({
  name: "desks-application",
  version: "3.1.0",
  environment: EmptyEnvironment,
  workflows: [OrdersWorkflow, RefundsWorkflow],
  providers: [RecordingCostLedgerRepository],
  budgets: TEST_BUDGETS,
})
export class DesksApplication {}

/** A third workflow opening at the orders start: a start is the door of one workflow. */
@Workflow({
  name: "orders-copy-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: [
    start(OrdersWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(RefundsAgent)
      .toFinish(RefundsWorkflowFinish),
  ],
})
export class OrdersCopyWorkflow {}

@Application({
  name: "ambiguous-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OrdersWorkflow, OrdersCopyWorkflow],
  budgets: TEST_BUDGETS,
})
export class AmbiguousApplication {}
