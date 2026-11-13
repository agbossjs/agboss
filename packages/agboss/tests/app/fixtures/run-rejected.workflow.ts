import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { crossFieldRule } from "../../../src/dto/schema.js";
import {
  Agent,
  Budget,
  BudgetPeriod,
  BudgetScope,
  Workflow,
  WorkflowStart,
  type BudgetHandler,
} from "../../../src/index.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { start } from "../../helpers/flow.js";
import { AnswerDto, Apply, Done, Lookup, RunLog } from "./run-events.workflow.js";
import { Application } from "../../../src/application/application.js";
import { TestApplicationDailyBudget, TestExecutionBudget } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** A start input with a code a rule checks; the rule's reason echoes the value it rejects. */
export class VoucherDto extends WorkflowStartTextDto {
  @Text({ prompt: "the voucher code" })
  code!: string;
}

crossFieldRule(VoucherDto, (voucher) =>
  voucher.code.startsWith("V-")
    ? undefined
    : { field: "code", reason: `"${voucher.code}" is not a voucher code` },
);

@WorkflowStart({
  name: "redeem-workflow-start",
  description: "Redeems a voucher",
  input: VoucherDto,
})
export class Redeem {}

@Agent({
  name: "voucher-clerk-agent",
  description: "Redeems vouchers",
  prompt: "Redeem the voucher.",
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
  maxSteps: 12,
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    tools: { maxToolCalls: 3 },
  },
  uncompactedTurns: 1,
  flow: [
    start(Redeem)
      .returns(VoucherDto)
      .toAgent(VoucherClerk)
      .returns(AnswerDto)
      .toFinish(Done),
  ],
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
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Vouchers],
  observers: [RunLog],
  budgets: [TestApplicationDailyBudget, VouchersTenantDailyBudget, TestExecutionBudget],
})
export class VouchersApplication {}
