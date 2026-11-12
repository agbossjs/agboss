/**
 * #659 AC1 / AC4 / AC6: the assembly rules of a question role — its name ends with `-question`, a
 * tool never names it, its interpreter is no decision model, it has one implementation.
 */
import { createAppWith } from "../../src/application/create-app.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
  ReplyInterpreter,
} from "../../src/channels/channel-role.decorator.js";
import { Channel, Tool, type ToolHandler } from "../../src/components/decorators.js";
import type { Class } from "../../src/components/injection.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { DecidedBy } from "../../src/flow/decorators/router.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { start } from "../flow/fixtures/paths.js";
import {
  DraftQuestionAction,
  PlacePurchaseAction,
  QuestionInbox,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "../flow/fixtures/questions.fixture.js";

const assemble = (application: Class) =>
  createAppWith(application, { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) });

const violationsOf = async (application: Class): Promise<unknown> => {
  const error: unknown = await assemble(application).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GraphRuleError);
  return (error as GraphRuleError).violations;
};

/** An application asking `role` from a flow step, with `providers`. */
function askingApplication(name: string, role: Class, providers: readonly Class[]): Class {
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(PurchaseWorkflowStart)
        .returns(WorkflowStartTextDto)
        .toAction(DraftQuestionAction)
        .returns(PurchaseQuestionDto)
        .toQuestion(role)
        .returns(SpendingLimitAnswerDto)
        .toAction(PlacePurchaseAction)
        .returns(PurchasePlacedDto)
        .toFinish(PurchaseWorkflowFinish),
    ],
    providers: [QuestionInbox],
  })
  class AskingWorkflow {}
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [AskingWorkflow],
    budgets: TEST_BUDGETS,
    providers,
  })
  class AskingApplication {}
  return AskingApplication;
}

/** A question role named `name` with `interpreter`, and its one channel. */
function questionRole(name: string, interpreter?: Class): { role: Class; channel: Class } {
  @ChannelRole({
    name,
    description: "d",
    ask: PurchaseQuestionDto,
    answer: SpendingLimitAnswerDto,
    answerer: PauseAnswerer.ThreadOwner,
    ...(interpreter === undefined ? {} : { replyInterpreter: interpreter }),
  })
  abstract class SomeQuestion extends ChannelOf<SomeQuestion> {}
  @Channel({ name: `${name}-inbox-channel`, description: "d" })
  class SomeInbox extends SomeQuestion {
    send(): Promise<ChannelOutcome<SomeQuestion>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  return { role: SomeQuestion, channel: SomeInbox };
}

describe("#659 AC1: a question role's name and implementation", () => {
  it("AC1: a question role whose name does not end with -question is [name.kind-suffix]", async () => {
    const { role, channel } = questionRole("limit-channel");

    expect(await violationsOf(askingApplication("suffix", role, [channel]))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "name.kind-suffix",
          message: expect.stringContaining(
            '"limit-channel" on @ChannelRole — name it "limit-channel-question"',
          ),
        }),
      ]),
    );
  });

  it("AC1: no implementation of the role is [di.missing-implementation]", async () => {
    const { role } = questionRole("unprovided-question");

    expect(await violationsOf(askingApplication("unprovided", role, []))).toEqual([
      expect.objectContaining({ code: "di.missing-implementation" }),
    ]);
  });

  it("AC1: a tool that names a question role is [channel.wrong-tool]", async () => {
    @Tool({
      name: "limit-tool",
      description: "d",
      input: PurchaseQuestionDto,
      output: PurchasePlacedDto,
      channel: SpendingLimitQuestion,
    })
    class LimitTool implements ToolHandler<PurchaseQuestionDto, PurchasePlacedDto> {
      run(): Promise<PurchasePlacedDto> {
        return Promise.resolve({ status: "ok" });
      }
    }
    @Agent({
      name: "limit-agent",
      description: "d",
      prompt: "p",
      model: "test/m",
      input: { message: WorkflowStartTextDto },
      output: PurchasePlacedDto,
      tools: [LimitTool],
    })
    class LimitAgent {}
    @Workflow({
      name: "tool-question-workflow",
      version: "1.0.0",
      flow: [
        start(PurchaseWorkflowStart)
          .returns(WorkflowStartTextDto)
          .toAgent(LimitAgent)
          .returns(PurchasePlacedDto)
          .toFinish(PurchaseWorkflowFinish),
      ],
    })
    class ToolQuestionWorkflow {}
    const { channel } = questionRole("unused-question");
    @Application({
      name: "tool-question-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [ToolQuestionWorkflow],
      budgets: TEST_BUDGETS,
      providers: [channel],
    })
    class ToolQuestionApplication {}

    expect(await violationsOf(ToolQuestionApplication)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "channel.wrong-tool",
          message: expect.stringContaining(
            "spending-limit-question asks a question (ask / answer), it approves no tool — ask it with .toQuestion(SpendingLimitQuestion)",
          ),
        }),
      ]),
    );
  });
});

describe("#659 AC4: a question role's interpreter", () => {
  it("AC4: a decision model cannot read a question's answer: [reply-interpreter.decision-model]", async () => {
    @ReplyInterpreter({
      name: "jev-limit-reply-interpreter",
      description: "d",
      decidedBy: DecidedBy.Model,
      model: "typesafe/jev-1.13",
    })
    class JevLimitReplyInterpreter {}
    const { role, channel } = questionRole("jev-limit-question", JevLimitReplyInterpreter);

    expect(await violationsOf(askingApplication("jev", role, [channel]))).toEqual([
      expect.objectContaining({
        code: "reply-interpreter.decision-model",
        message: expect.stringContaining(
          "typesafe/jev-1.13 is a decision model — it answers only yes / no (approved), but channel role jev-limit-question asks for SpendingLimitAnswerDto",
        ),
      }),
    ]);
  });

  it("AC4: a chat model interpreter assembles", async () => {
    @ReplyInterpreter({
      name: "chat-limit-reply-interpreter",
      description: "d",
      decidedBy: DecidedBy.Model,
      model: "test/m",
    })
    class ChatLimitReplyInterpreter {}
    const { role, channel } = questionRole("chat-limit-question", ChatLimitReplyInterpreter);

    const app = await assemble(askingApplication("chat", role, [channel]));
    expect(app.warnings).toEqual(
      // a question can pause: the in-memory pause store is named (#659 asks through the pause seam)
      expect.arrayContaining([expect.stringContaining("[application.in-memory-pauses]")]),
    );
    await app.close();
  });
});
