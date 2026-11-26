import { Window1Memory } from "../../helpers/window-memory.js";
import { Text, Validate, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  Budget,
  BudgetPeriod,
  BudgetScope,
  Workflow,
  WorkflowStart,
  type BudgetHandler,
  inline,
  Ttl,
} from "../../../src/index.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { onStart } from "../../helpers/flow.js";
import { AnswerDto, Apply, Done, Lookup, RunLog } from "./run-events.workflow.js";
import { Application } from "../../../src/application/application.js";
import { TestApplicationDailyBudget, TestExecutionBudget } from "../../flow/fixtures/budgets.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/** A start input with a code a rule checks; the rule's reason echoes the value it rejects. */
@Validate<VoucherDto>((voucher) =>
  voucher.code.startsWith("V-")
    ? undefined
    : { field: "code", reason: `"${voucher.code}" is not a voucher code` },
)
export class VoucherDto extends WorkflowStartTextDto {
  @Text({ prompt: "the voucher code" })
  code!: string;
}

@WorkflowStart({
  name: "redeem-workflow-start",
  description: "Redeems a voucher",
  input: VoucherDto,
})
export class Redeem {}

@Agent({
  name: "voucher-clerk-agent",
  description: "Redeems vouchers",
  prompt: inline("Redeem the voucher."),
  tools: [Lookup, Apply],
  model: "test/clerk",
  input: { voucher: VoucherDto },
  output: AnswerDto,
})
export class VoucherClerk {}

/** redeem → clerk → done, observed by `RunLog` (its `rejections` too); $0.05 a day. */
@Workflow({
  name: "vouchers-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 12 },
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    tools: { maxToolCalls: 3 },
  },
  memory: Window1Memory,
  flow: [onStart(Redeem)
    .toAgent(VoucherClerk)
    .toFinish(Done)],
})
export class Vouchers {}

/** A tenant may spend $0.05 a day: one dear reply spends it. */
@Budget({
  name: "vouchers-tenant-daily-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
})
export class VouchersTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

@Application({
  name: "vouchers-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [Vouchers],
  observers: [RunLog],
  budgets: [TestApplicationDailyBudget, VouchersTenantDailyBudget, TestExecutionBudget],
})
export class VouchersApplication {}
