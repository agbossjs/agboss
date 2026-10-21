import {
  Agent,
  Budget,
  BudgetPeriod,
  BudgetScope,
  EmptyEnvironment,
  ExecutionContext,
  MODEL_MAX,
  TenantContext,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Injectable } from "../../../src/components/decorators.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import {
  Decimal,
  Text,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { start } from "../../helpers/flow.js";

/**
 * #261 PR 5: an application whose budgets read the execution — the tenant's own daily amount from
 * its context (server-side data, never the request), the execution budget from the step it runs in
 * — and a two-agent workflow: start → drafter → reviewer → done.
 */

/** Every `maxSpend()` call, as `budget@tenant:step` (the execution it read). */
export const maxSpendReads: string[] = [];

/** The ledger of each application instance, for a test to read its counters. */
export const shopLedgers: ShopCostLedgerRepository[] = [];

/** The in-memory ledger, listed so the test sees the instance the budgets count in. */
@Injectable()
export class ShopCostLedgerRepository extends InMemoryCostLedgerRepository {
  constructor() {
    super();
    shopLedgers.push(this);
  }
}

/** The tenant's own fields: its daily amount, from the caller's server-side tenant data. */
export class ShopTenantContext extends TenantContext {
  @Decimal()
  dailyBudgetUsd!: number;
}

@WorkflowStart({
  name: "brief-workflow-start",
  description: "A brief",
  input: WorkflowStartTextDto,
})
export class BriefStart {}

@WorkflowFinish({
  name: "brief-workflow-finish",
  description: "The text",
  output: WorkflowFinishTextDto,
})
export class BriefFinish {}

export class DraftDto {
  @Text({ prompt: "the draft" })
  text!: string;
}

const defaults = {
  models: { temperature: 0, maxTokens: MODEL_MAX, cache: true },
  tools: { maxToolCalls: 2 },
} as const;
const price = { inputPerMTok: 1, outputPerMTok: 10 };

@Agent({
  name: "drafter-agent",
  description: "Drafts",
  prompt: "Draft it.",
  model: "test/drafter",
  price,
  output: DraftDto,
})
export class DrafterAgent {}

@Agent({
  name: "reviewer-agent",
  description: "Reviews",
  prompt: "Review it.",
  model: "test/reviewer",
  price,
  input: { draft: DraftDto },
})
export class ReviewerAgent {}

@Workflow({
  name: "brief-workflow",
  version: "1.0.0",
  flow: [
    start(BriefStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DrafterAgent)
      .returns(DraftDto)
      .toAgent(ReviewerAgent)
      .toFinish(BriefFinish),
  ],
  defaults,
  uncompactedTurns: 2,
})
export class BriefWorkflow {}

@Budget({
  name: "shop-application-daily-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class ShopApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({
  name: "shop-tenant-daily-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  deps: [ShopTenantContext],
})
export class ShopTenantDailyBudget implements BudgetHandler {
  constructor(private readonly shopTenantContext: ShopTenantContext) {}

  maxSpend(): Usd {
    maxSpendReads.push(`shop-tenant-daily-budget@${this.shopTenantContext.tenantId}`);
    return usd(this.shopTenantContext.dailyBudgetUsd);
  }
}

@Budget({
  name: "shop-tenant-monthly-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Month,
})
export class ShopTenantMonthlyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}

@Budget({
  name: "brief-execution-budget",
  scope: BudgetScope.Execution,
  workflow: BriefWorkflow,
  deps: [ExecutionContext],
})
export class BriefExecutionBudget implements BudgetHandler {
  constructor(private readonly executionContext: ExecutionContext) {}

  maxSpend(): Usd {
    const { tenant, step } = this.executionContext;
    maxSpendReads.push(`brief-execution-budget@${tenant.tenantId}:${step.nodeId}`);
    return usd(0.5);
  }
}

@Application({
  name: "shop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BriefWorkflow],
  tenantContext: ShopTenantContext,
  providers: [ShopCostLedgerRepository],
  budgets: [
    ShopApplicationDailyBudget,
    ShopTenantDailyBudget,
    ShopTenantMonthlyBudget,
    BriefExecutionBudget,
  ],
})
export class ShopApplication {}
