import { StepError } from "../../../src/core/error-families/step-errors.js";
import { Application } from "../../../src/application/application.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelInterpretation,
  ChannelInterpreter,
} from "../../../src/channels/channel-interpreter.js";
import { Channel, Injectable } from "../../../src/components/decorators.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import {
  onStart as publicStart,
  toExternalTask as publicToQuestion,
} from "../../../src/flow/builder.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { PathSource } from "../../../src/flow/ast.js";
import type { PathBuilder } from "../../../src/flow/path-builder.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { onExternalTask, onStart, toExternalTask } from "./paths.js";
import {
  DraftQuestionAction,
  InboxSpendingLimitChannel,
  PlacePurchaseAction,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  QuestionInbox,
  SpendingLimitAnswerDto,
  SpendingLimitQuestionExternalTask,
} from "./questions.fixture.js";
import { FlakyCheckAction } from "./side-question.fixture.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { ExternalTask } from "../../../src/channels/pause-targets.js";
import { days, Ttl } from "../../../src/units/index.js";

/**
 * #933 — tests of the shipped `toQuestion` starter, and the edge case of one question role used on
 * the main path and on the side path (one class is one node, its `maxVisits` counts both visits).
 */

/** The workflow written with the SHIPPED starters of `builder.ts`, not the fixture ones of `paths.ts`. */
@WorkflowStart({
  name: "public-starter-workflow-start",
  description: "d",
  input: WorkflowStartTextDto,
})
export class PublicStarterWorkflowStart {}

@Workflow({
  name: "public-starter-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    publicStart(PublicStarterWorkflowStart)
      .toAction(DraftQuestionAction)
      .toAction(FlakyCheckAction)
      .onError(
        StepError,
        publicToQuestion(SpendingLimitQuestionExternalTask)
          .toAction(PlacePurchaseAction)
          .toFinish(PurchaseWorkflowFinish),
      )
      .toFinish(PurchaseWorkflowFinish),
  ],
  providers: [QuestionInbox],
})
export class PublicStarterWorkflow {}

/** Counts its calls; the first one fails, the next ones place. */
@Injectable()
export class EdgeCalls {
  calls = 0;
}

@Action({
  name: "fail-first-place-action",
  description: "Fails its first call, places after",
  input: { question: PurchaseQuestionDto, answer: SpendingLimitAnswerDto },
  output: PurchasePlacedDto,
  deps: [EdgeCalls],
})
export class FailFirstPlaceAction implements ActionHandler<FailFirstPlaceAction> {
  constructor(private readonly edgeCalls: EdgeCalls) {}

  execute({
    question: asked,
    answer,
  }: InputOf<FailFirstPlaceAction>): Promise<OutputOf<FailFirstPlaceAction>> {
    this.edgeCalls.calls += 1;
    if (this.edgeCalls.calls === 1) return Promise.reject(new Error("the first place fails"));
    return Promise.resolve({
      status: `placed ${asked.item} within ${String(answer.limitUsd)}`,
    });
  }
}

/** Reads the first number of the reply as the limit. */
const limitOf = (reply: string) =>
  ChannelInterpretation.understood({
    approved: true,
    limitUsd: Number(/\d+/.exec(reply)?.[0] ?? 0),
  });

@ChannelInterpreter({
  name: "edge-once-reply-interpreter",
  description: "Reads the limit",
})
export class EdgeOnceInterpreter {
  interpret(
    input: InputOf<EdgeOnceInterpreter>,
  ): ChannelInterpretation<OutputOf<EdgeOnceInterpreter>> {
    return limitOf(input.reply);
  }
}

@ChannelInterpreter({
  name: "edge-twice-reply-interpreter",
  description: "Reads the limit",
})
export class EdgeTwiceInterpreter {
  interpret(
    input: InputOf<EdgeTwiceInterpreter>,
  ): ChannelInterpretation<OutputOf<EdgeTwiceInterpreter>> {
    return limitOf(input.reply);
  }
}

/** One visit allowed: the side-path ask is the second visit of the node. */
@ExternalTask({
  name: "edge-once-external-task",
  description: "Asks the thread's owner",
  input: PurchaseQuestionDto,
  output: SpendingLimitAnswerDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
  channelInterpreter: EdgeOnceInterpreter,
  maxVisits: 1,
})
export class EdgeOnceExternalTask {}

@ExternalTask({
  name: "edge-twice-external-task",
  description: "Asks the thread's owner",
  input: PurchaseQuestionDto,
  output: SpendingLimitAnswerDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
  channelInterpreter: EdgeTwiceInterpreter,
  maxVisits: 2,
})
export class EdgeTwiceExternalTask {}

@Channel({
  name: "edge-once-channel",
  description: "inbox",
  target: EdgeOnceExternalTask,
  ttl: days(1),
})
export class EdgeOnceChannel {
  send(_ask: ChannelAsk<EdgeOnceExternalTask>): Promise<ChannelOutcome<EdgeOnceExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({
  name: "edge-twice-channel",
  description: "inbox",
  target: EdgeTwiceExternalTask,
  ttl: days(1),
})
export class EdgeTwiceChannel {
  send(_ask: ChannelAsk<EdgeTwiceExternalTask>): Promise<ChannelOutcome<EdgeTwiceExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({ name: "edge-once-workflow-start", description: "d", input: WorkflowStartTextDto })
export class EdgeOnceStart {}

@WorkflowStart({ name: "edge-twice-workflow-start", description: "d", input: WorkflowStartTextDto })
export class EdgeTwiceStart {}

/** One node: `.toExternalTask(R)` on the main path, `onExternalTask(R)…` its path, the side path back to R. */
export const sharedEdgeFlow = (
  startClass: abstract new () => unknown,
  role: abstract new () => unknown,
): PathBuilder<PathSource>[] => [
  onStart(startClass)
    .toAction(DraftQuestionAction)
    .toExternalTask(role),
  onExternalTask(role)
    .toAction(FailFirstPlaceAction)
    .onError(StepError, toExternalTask(role))
    .toFinish(PurchaseWorkflowFinish),
];

/** The same role written inline on both paths: two continuations of one node. */
export const inlineTwiceEdgeFlow = (
  startClass: abstract new () => unknown,
  role: abstract new () => unknown,
): PathBuilder<PathSource>[] => [
  onStart(startClass)
    .toAction(DraftQuestionAction)
    .toExternalTask(role)
    .toAction(FailFirstPlaceAction)
    .onError(
      StepError,
      toExternalTask(role)
        .toAction(PlacePurchaseAction)
        .toFinish(PurchaseWorkflowFinish),
    )
    .toFinish(PurchaseWorkflowFinish),
];

@Workflow({
  name: "edge-once-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: sharedEdgeFlow(EdgeOnceStart, EdgeOnceExternalTask),
  providers: [QuestionInbox, EdgeCalls],
})
export class EdgeOnceWorkflow {}

@Workflow({
  name: "edge-twice-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: sharedEdgeFlow(EdgeTwiceStart, EdgeTwiceExternalTask),
  providers: [QuestionInbox, EdgeCalls],
})
export class EdgeTwiceWorkflow {}

@Application({
  name: "side-question-edge-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PublicStarterWorkflow, EdgeOnceWorkflow, EdgeTwiceWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InboxSpendingLimitChannel, EdgeOnceChannel, EdgeTwiceChannel],
})
export class SideQuestionEdgeApplication {}
