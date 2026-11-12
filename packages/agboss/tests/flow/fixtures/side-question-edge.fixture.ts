import { Application } from "../../../src/application/application.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
  ReplyInterpretation,
  ReplyInterpreter,
  type ReplyInterpreterHandler,
} from "../../../src/channels/channel-role.decorator.js";
import { Channel, Injectable } from "../../../src/components/decorators.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { start as publicStart, toQuestion as publicToQuestion } from "../../../src/flow/builder.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import type { PathSource } from "../../../src/flow/ast.js";
import type { PathBuilder } from "../../../src/flow/path-builder.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { question, start, toQuestion } from "./paths.js";
import {
  DraftQuestionAction,
  InboxSpendingLimitChannel,
  PlacePurchaseAction,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  QuestionInbox,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "./questions.fixture.js";
import { FlakyCheckAction } from "./side-question.fixture.js";

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
  flow: [
    publicStart(PublicStarterWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(DraftQuestionAction)
      .returns(PurchaseQuestionDto)
      .toAction(FlakyCheckAction)
      .onError(
        StepFailedError,
        publicToQuestion(SpendingLimitQuestion)
          .returns(SpendingLimitAnswerDto)
          .toAction(PlacePurchaseAction)
          .returns(PurchasePlacedDto)
          .toFinish(PurchaseWorkflowFinish),
      )
      .returns(PurchasePlacedDto)
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
      status: `placed ${asked.value.item} within ${String(answer.value.limitUsd)}`,
    });
  }
}

/** Reads the first number of the reply as the limit. */
const limitOf = (reply: string) =>
  ReplyInterpretation.understood({
    approved: true,
    limitUsd: Number(/\d+/.exec(reply)?.[0] ?? 0),
  });

@ReplyInterpreter({
  name: "edge-once-reply-interpreter",
  description: "Reads the limit",
  decidedBy: DecidedBy.Code,
})
export class EdgeOnceInterpreter implements ReplyInterpreterHandler<EdgeOnceInterpreter> {
  interpret(
    input: InputOf<EdgeOnceInterpreter>,
  ): ReplyInterpretation<OutputOf<EdgeOnceInterpreter>> {
    return limitOf(input.reply);
  }
}

@ReplyInterpreter({
  name: "edge-twice-reply-interpreter",
  description: "Reads the limit",
  decidedBy: DecidedBy.Code,
})
export class EdgeTwiceInterpreter implements ReplyInterpreterHandler<EdgeTwiceInterpreter> {
  interpret(
    input: InputOf<EdgeTwiceInterpreter>,
  ): ReplyInterpretation<OutputOf<EdgeTwiceInterpreter>> {
    return limitOf(input.reply);
  }
}

/** One visit allowed: the side-path ask is the second visit of the node. */
@ChannelRole({
  name: "edge-once-question",
  description: "Asks the thread's owner",
  ask: PurchaseQuestionDto,
  answer: SpendingLimitAnswerDto,
  answeredBy: PauseAnswerer.ThreadOwner,
  replyInterpreter: EdgeOnceInterpreter,
  maxVisits: 1,
})
export abstract class EdgeOnceQuestion extends ChannelOf<EdgeOnceQuestion> {}

@ChannelRole({
  name: "edge-twice-question",
  description: "Asks the thread's owner",
  ask: PurchaseQuestionDto,
  answer: SpendingLimitAnswerDto,
  answeredBy: PauseAnswerer.ThreadOwner,
  replyInterpreter: EdgeTwiceInterpreter,
  maxVisits: 2,
})
export abstract class EdgeTwiceQuestion extends ChannelOf<EdgeTwiceQuestion> {}

@Channel({ name: "edge-once-channel", description: "inbox" })
export class EdgeOnceChannel extends EdgeOnceQuestion {
  send(_ask: ChannelAsk<EdgeOnceQuestion>): Promise<ChannelOutcome<EdgeOnceQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({ name: "edge-twice-channel", description: "inbox" })
export class EdgeTwiceChannel extends EdgeTwiceQuestion {
  send(_ask: ChannelAsk<EdgeTwiceQuestion>): Promise<ChannelOutcome<EdgeTwiceQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@WorkflowStart({ name: "edge-once-workflow-start", description: "d", input: WorkflowStartTextDto })
export class EdgeOnceStart {}

@WorkflowStart({ name: "edge-twice-workflow-start", description: "d", input: WorkflowStartTextDto })
export class EdgeTwiceStart {}

/** One node: `.toQuestion(R)` on the main path, `question(R)…` its path, the side path back to R. */
export const sharedEdgeFlow = (
  startClass: abstract new () => unknown,
  role: abstract new () => unknown,
): PathBuilder<PathSource>[] => [
  start(startClass)
    .returns(WorkflowStartTextDto)
    .toAction(DraftQuestionAction)
    .returns(PurchaseQuestionDto)
    .toQuestion(role),
  question(role)
    .returns(SpendingLimitAnswerDto, { about: PurchaseQuestionDto })
    .toAction(FailFirstPlaceAction)
    .onError(StepFailedError, toQuestion(role))
    .returns(PurchasePlacedDto)
    .toFinish(PurchaseWorkflowFinish),
];

/** The same role written inline on both paths: two continuations of one node. */
export const inlineTwiceEdgeFlow = (
  startClass: abstract new () => unknown,
  role: abstract new () => unknown,
): PathBuilder<PathSource>[] => [
  start(startClass)
    .returns(WorkflowStartTextDto)
    .toAction(DraftQuestionAction)
    .returns(PurchaseQuestionDto)
    .toQuestion(role)
    .returns(SpendingLimitAnswerDto)
    .toAction(FailFirstPlaceAction)
    .onError(
      StepFailedError,
      toQuestion(role)
        .returns(SpendingLimitAnswerDto)
        .toAction(PlacePurchaseAction)
        .returns(PurchasePlacedDto)
        .toFinish(PurchaseWorkflowFinish),
    )
    .returns(PurchasePlacedDto)
    .toFinish(PurchaseWorkflowFinish),
];

@Workflow({
  name: "edge-once-workflow",
  version: "1.0.0",
  flow: sharedEdgeFlow(EdgeOnceStart, EdgeOnceQuestion),
  providers: [QuestionInbox, EdgeCalls],
})
export class EdgeOnceWorkflow {}

@Workflow({
  name: "edge-twice-workflow",
  version: "1.0.0",
  flow: sharedEdgeFlow(EdgeTwiceStart, EdgeTwiceQuestion),
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
