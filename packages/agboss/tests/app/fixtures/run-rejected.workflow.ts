import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { crossFieldRule } from "../../../src/dto/schema.js";
import {
  Agent,
  Workflow,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
} from "../../../src/index.js";
import { usd } from "../../../src/units/index.js";
import { start } from "../../helpers/flow.js";
import { AnswerDto, Apply, Done, Lookup, RunLog } from "./run-events.workflow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
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
    history: { limit: 1 },
    tools: { maxToolCalls: 3 },
  },
  observers: [RunLog],
  channelClasses: [TerminalUserChannel],
  flow: [
    start(Redeem)
      .returns(VoucherDto)
      .toAgent(VoucherClerk)
      .returns(AnswerDto)
      .toFinish(Done),
  ],
})
export class Vouchers implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.05) }, perDay: { cost: usd(0.05) } })
      .build();
  }
}

@Application({
  name: "vouchers-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [Vouchers],
  budgets: TEST_BUDGETS,
})
export class VouchersApplication {}
