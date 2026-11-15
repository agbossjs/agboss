// `agboss run` after a pause (#1123): one agent on the default OpenRouter provider whose only tool
// asks for an approval in the terminal (its role is answered by the thread's owner).
import {
  Agent,
  Application,
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  PauseAnswerer,
  TokenLimit,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type ToolHandler,
} from "../../../../../agboss/src/index.js";
import {
  Text,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../../../agboss/src/dto/index.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { start } from "../../../../../agboss/tests/helpers/flow.js";
import { StreamEnvironment } from "./environments/app.environment.js";

@WorkflowStart({
  name: "pause-ask-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class PauseAskStart {}

@WorkflowFinish({
  name: "pause-answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class PauseAnswerFinish {}

export class RefundRequest {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

class RefundDone {
  @Text()
  status!: string;
}

@ChannelRole({
  name: "pause-refund-approval-channel",
  description: "Approves refunds",
  approves: RefundRequest,
  answerer: PauseAnswerer.ThreadOwner,
})
export abstract class PauseRefundApproval extends ChannelOf<PauseRefundApproval> {}

/** Posts nothing: the terminal asks the thread's owner. */
@Channel({ name: "pause-silent-refund-channel" })
export class PauseSilentRefundChannel extends PauseRefundApproval {
  send(_ask: ChannelAsk<PauseRefundApproval>): Promise<ChannelOutcome<PauseRefundApproval>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "pause-refund-tool",
  description: "Refunds an order",
  input: RefundRequest,
  output: RefundDone,
  channel: PauseRefundApproval,
})
export class PauseRefund implements ToolHandler<RefundRequest, RefundDone> {
  run({ orderId }: RefundRequest): Promise<RefundDone> {
    return Promise.resolve({ status: `refunded ${orderId}` });
  }
}

@Agent({
  name: "pause-clerk-agent",
  description: "Refunds orders",
  prompt: "Refund the order the user names.",
  model: "stream/model",
  tools: [PauseRefund],
})
export class PauseClerk {}

@Workflow({
  name: "pause-workflow",
  version: "1.0.0",
  flow: [
    start(PauseAskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(PauseClerk)
      .toFinish(PauseAnswerFinish),
  ],
  defaults: { models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX } },
})
export class PauseWorkflow {}

@Application({
  name: "stream-pause-application",
  version: "1.0.0",
  environment: StreamEnvironment,
  workflows: [PauseWorkflow],
  providers: [PauseSilentRefundChannel],
  budgets: TEST_BUDGETS,
})
export class StreamPauseApplication {}
