import { Application } from "../../../../agboss/src/application/application.js";
import { ChannelOutcome } from "../../../../agboss/src/channels/channel-outcome.js";
import { Channel } from "../../../../agboss/src/components/decorators.js";
import { Bool, Integer, Text } from "../../../../agboss/src/dto/index.js";
import { EmptyEnvironment } from "../../../../agboss/src/environments/empty.js";
import { Workflow } from "../../../../agboss/src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../agboss/src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../agboss/src/flow/decorators/workflow-start.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { onStart } from "../../../../agboss/tests/flow/fixtures/paths.js";
import { PauseRespondent } from "../../../../agboss/src/pause/respondent.js";
import { ExternalTask } from "../../../../agboss/src/channels/pause-targets.js";
import { days, Ttl } from "../../../../agboss/src/units/index.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

/** #659 — a question the terminal answers: the limit of a purchase, typed as JSON. */

export class LimitQuestionDto {
  @Text({ prompt: "what is bought" })
  item!: string;
}

export class LimitAnswerDto {
  @Bool({ prompt: "whether it may go on" })
  approved!: boolean;

  @Integer({ prompt: "the limit in dollars", min: 0 })
  limitUsd!: number;
}

@ExternalTask({
  name: "limit-external-task",
  description: "Asks the thread's owner for a limit",
  input: LimitQuestionDto,
  output: LimitAnswerDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class LimitExternalTask {}

@Channel({
  name: "terminal-limit-channel",
  description: "Waits for the terminal",
  target: LimitExternalTask,
  ttl: days(1),
})
export class TerminalLimitChannel {
  send(): Promise<ChannelOutcome<LimitExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({ name: "limit-workflow-start", description: "d", input: LimitQuestionDto })
export class LimitWorkflowStart {}

@WorkflowFinish({ name: "limit-workflow-finish", description: "d", output: LimitAnswerDto })
export class LimitWorkflowFinish {}

@Workflow({
  name: "limit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(LimitWorkflowStart)
      .toExternalTask(LimitExternalTask)
      .toFinish(LimitWorkflowFinish),
  ],
})
export class LimitWorkflow {}

@Application({
  modelProvider: TestModelProvider,
  name: "limit-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LimitWorkflow],
  budgets: TEST_BUDGETS,
  providers: [TerminalLimitChannel],
})
export class LimitApplication {}
