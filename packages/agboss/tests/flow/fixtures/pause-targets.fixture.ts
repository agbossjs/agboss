import { Channel, Tool } from "../../../src/components/decorators.js";
import type { ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelInterpretation,
  ChannelInterpreter,
} from "../../../src/channels/channel-interpreter.js";
import {
  ExternalTask,
  PauseRespondent,
  ToolApproval,
} from "../../../src/channels/pause-targets.js";
import type {
  AnswerPermissionContext,
  AssignContext,
} from "../../../src/channels/pause-contexts.js";
import { Integer, Text } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { days, hours, Ttl } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { Application } from "../../../src/application/application.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { onStart } from "./paths.js";
import { inline } from "../../../src/index.js";

/**
 * #1307a / #1310c — the pause targets in their new names, for the generated types (`PauseTargets`,
 * `PauseInputOf` / `PauseOutputOf`) and the compile-time pins: an approval with and without `input`,
 * an external task, a code interpreter with no `implements`.
 */

export class PtPayoutDto {
  @Text({ prompt: "the payee" })
  payee!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

export class PtPayoutDoneDto {
  @Text()
  status!: string;
}

export class PtLimitAskDto {
  @Text({ prompt: "what is bought" })
  item!: string;
}

export class PtLimitAnswerDto {
  @Integer({ prompt: "the most it may cost", min: 0 })
  limitUsd!: number;
}

/** Gates the payout tool; its hooks read the typed contexts. */
@ToolApproval({
  name: "pt-payout-tool-approval",
  description: "Approves payouts",
  input: PtPayoutDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(4),
})
export class PtPayoutToolApproval {
  assign({ input }: AssignContext<PtPayoutToolApproval>): readonly string[] {
    return [input.payee];
  }

  permitAnswer({ input, output }: AnswerPermissionContext<PtPayoutToolApproval>): boolean {
    return output.approved && input.amountCents > 0;
  }
}

/** Gates any tool that names it. */
@ToolApproval({
  name: "pt-any-tool-approval",
  description: "Approves any tool call",
  respondent: PauseRespondent.Owner,
  timeout: hours(1),
})
export class PtAnyToolApproval {}

@ChannelInterpreter()
export class PtLimitChannelInterpreter {
  interpret(
    input: InputOf<PtLimitChannelInterpreter>,
  ): ChannelInterpretation<OutputOf<PtLimitChannelInterpreter>> {
    if (input.reply.length === 0) return ChannelInterpretation.notUnderstood("empty");
    const understood = { limitUsd: 100 } satisfies OutputOf<PtLimitChannelInterpreter>;
    return ChannelInterpretation.understood(understood);
  }
}

@ExternalTask({
  name: "pt-limit-external-task",
  description: "Asks for a spending limit",
  input: PtLimitAskDto,
  output: PtLimitAnswerDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(1),
  channelInterpreter: PtLimitChannelInterpreter,
})
export class PtLimitExternalTask {}

@Channel({
  name: "pt-payout-channel",
  description: "The finance desk",
  target: PtPayoutToolApproval,
  ttl: days(7),
})
export class PtPayoutChannel {
  send(_ask: ChannelAsk<PtPayoutToolApproval>): Promise<ChannelOutcome<PtPayoutToolApproval>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "pt-payout-tool",
  description: "Pays out",
  input: PtPayoutDto,
  output: PtPayoutDoneDto,
  approval: PtPayoutToolApproval,
})
export class PtPayoutTool {
  execute(): Promise<PtPayoutDoneDto> {
    return Promise.resolve({ status: "paid" });
  }
}

@Channel({
  name: "pt-any-channel",
  description: "The owner's inbox",
  target: PtAnyToolApproval,
  ttl: days(1),
})
export class PtAnyChannel {
  send(_ask: ChannelAsk<PtAnyToolApproval>): Promise<ChannelOutcome<PtAnyToolApproval>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({
  name: "pt-limit-channel",
  description: "The finance desk's limits",
  target: PtLimitExternalTask,
  ttl: days(7),
})
export class PtLimitChannel {
  send(_ask: ChannelAsk<PtLimitExternalTask>): Promise<ChannelOutcome<PtLimitExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "pt-note-tool",
  description: "Writes a note",
  input: PtLimitAskDto,
  output: PtPayoutDoneDto,
  approval: PtAnyToolApproval,
})
export class PtNoteTool {
  execute(): Promise<PtPayoutDoneDto> {
    return Promise.resolve({ status: "noted" });
  }
}

@Agent({
  name: "pt-payer-agent",
  description: "Pays out",
  prompt: inline("Pay out."),
  model: "test/payer",
  input: { message: WorkflowStartTextDto },
  output: PtPayoutDoneDto,
  tools: [PtPayoutTool, PtNoteTool],
})
export class PtPayerAgent {}

@WorkflowStart({ name: "pt-payout-workflow-start", description: "d", input: WorkflowStartTextDto })
export class PtPayoutWorkflowStart {}

@WorkflowFinish({ name: "pt-payout-workflow-finish", description: "d", output: PtPayoutDoneDto })
export class PtPayoutWorkflowFinish {}

@Workflow({
  name: "pt-payout-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(PtPayoutWorkflowStart).toAgent(PtPayerAgent).toFinish(PtPayoutWorkflowFinish)],
})
export class PtPayoutWorkflow {}

@WorkflowStart({ name: "pt-limit-workflow-start", description: "d", input: PtLimitAskDto })
export class PtLimitWorkflowStart {}

@WorkflowFinish({ name: "pt-limit-workflow-finish", description: "d", output: PtLimitAnswerDto })
export class PtLimitWorkflowFinish {}

@Workflow({
  name: "pt-limit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PtLimitWorkflowStart)
      .toExternalTask(PtLimitExternalTask)
      .toFinish(PtLimitWorkflowFinish),
  ],
})
export class PtLimitWorkflow {}

@Application({
  name: "pt-application",
  version: "1.0.0",
  workflows: [PtPayoutWorkflow, PtLimitWorkflow],
  budgets: TEST_BUDGETS,
  channels: [PtPayoutChannel, PtAnyChannel, PtLimitChannel],
})
export class PtApplication {}
