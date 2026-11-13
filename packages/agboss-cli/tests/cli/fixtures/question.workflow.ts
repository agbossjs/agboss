import { Application } from "../../../../agboss/src/application/application.js";
import { ChannelOf } from "../../../../agboss/src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../../agboss/src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
} from "../../../../agboss/src/channels/channel-role.decorator.js";
import { Channel } from "../../../../agboss/src/components/decorators.js";
import { Flag, Integer, Text } from "../../../../agboss/src/dto/index.js";
import { EmptyEnvironment } from "../../../../agboss/src/environments/empty.js";
import { Workflow } from "../../../../agboss/src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../agboss/src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../agboss/src/flow/decorators/workflow-start.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { start } from "../../../../agboss/tests/flow/fixtures/paths.js";

/** #659 — a question the terminal answers: the limit of a purchase, typed as JSON. */

export class LimitQuestionDto {
  @Text({ prompt: "what is bought" })
  item!: string;
}

export class LimitAnswerDto {
  @Flag({ prompt: "whether it may go on" })
  approved!: boolean;

  @Integer({ prompt: "the limit in dollars", min: 0 })
  limitUsd!: number;
}

@ChannelRole({
  name: "limit-question",
  description: "Asks the thread's owner for a limit",
  ask: LimitQuestionDto,
  answer: LimitAnswerDto,
  answerer: PauseAnswerer.ThreadOwner,
})
export abstract class LimitQuestion extends ChannelOf<LimitQuestion> {}

@Channel({ name: "terminal-limit-channel", description: "Waits for the terminal" })
export class TerminalLimitChannel extends LimitQuestion {
  send(): Promise<ChannelOutcome<LimitQuestion>> {
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
  flow: [
    start(LimitWorkflowStart)
      .returns(LimitQuestionDto)
      .toQuestion(LimitQuestion)
      .returns(LimitAnswerDto)
      .toFinish(LimitWorkflowFinish),
  ],
})
export class LimitWorkflow {}

@Application({
  name: "limit-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LimitWorkflow],
  budgets: TEST_BUDGETS,
  providers: [TerminalLimitChannel],
})
export class LimitApplication {}
