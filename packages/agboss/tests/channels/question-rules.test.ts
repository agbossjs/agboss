/**
 * #659 AC1 / AC4 / AC6: the assembly rules of a question role — its name ends with `-question`, a
 * tool never names it, its interpreter is no decision model, it has one implementation.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { ChannelInterpreter } from "../../src/channels/channel-interpreter.js";
import { Channel, Tool } from "../../src/components/decorators.js";
import type { Class } from "../../src/components/injection.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { inline, ExternalTask, Ttl } from "../../src/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { onStart } from "../flow/fixtures/paths.js";
import {
  DraftQuestionAction,
  PlacePurchaseAction,
  QuestionInbox,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  SpendingLimitAnswerDto,
  SpendingLimitQuestionExternalTask,
} from "../flow/fixtures/questions.fixture.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { days } from "../../src/units/index.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";
import { TestDecisionsModelProvider } from "../../src/testing/test-model-provider.js";

const assemble = (application: Class) =>
  createTestAppWith(application, {
    processEnv: {},
    gateway: createScriptedGateway(new ScriptBook()),
  });

const violationsOf = async (application: Class): Promise<unknown> => {
  const error: unknown = await assemble(application).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(ConfigError.GraphRules);
  return (error as ConfigError.GraphRules).violations;
};

/** An application asking `role` from a flow step, with `providers`. */
function askingApplication(name: string, role: Class, providers: readonly Class[]): Class {
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(PurchaseWorkflowStart)
        .toAction(DraftQuestionAction)
        .toExternalTask(role)
        .toAction(PlacePurchaseAction)
        .toFinish(PurchaseWorkflowFinish),
    ],
    providers: [QuestionInbox],
  })
  class AskingWorkflow {}
  @Application({
    name: `${name}-application`,
    modelProvider: TestModelProvider,
    version: "1.0.0",
    workflows: [AskingWorkflow],
    budgets: TEST_BUDGETS,
    providers,
  })
  class AskingApplication {}
  return AskingApplication;
}

/** A question role named `name` with `interpreter`, and its one channel. */
function questionRole(name: string, interpreter?: Class): { role: Class; channel: Class } {
  @ExternalTask({
    name,
    description: "d",
    input: PurchaseQuestionDto,
    output: SpendingLimitAnswerDto,
    respondent: PauseRespondent.Owner,
    timeout: days(365),
    ...(interpreter === undefined ? {} : { channelInterpreter: interpreter }),
  })
  class SomeQuestionExternalTask {}
  @Channel({
    name: `${name}-inbox-channel`,
    description: "d",
    target: SomeQuestionExternalTask,
    ttl: days(1),
  })
  class SomeInbox {
    send(): Promise<ChannelOutcome<SomeQuestionExternalTask>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  return { role: SomeQuestionExternalTask, channel: SomeInbox };
}

describe("#659 AC1: a question role's name and implementation", () => {
  it("AC1: a question role whose name does not end with -question is [name.kind-suffix]", async () => {
    const { role, channel } = questionRole("limit-channel");

    expect(await violationsOf(askingApplication("suffix", role, [channel]))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "name.kind-suffix",
          message: expect.stringContaining(
            '"limit-channel" on @ExternalTask — name it "limit-channel-external-task"',
          ),
        }),
      ]),
    );
  });

  it("AC1: an owner target with no channel is channel-less: it assembles, the pause waits for app.resume", async () => {
    const { role } = questionRole("unprovided-external-task");

    const app = await assemble(askingApplication("unprovided", role, []));
    expect(app).toBeDefined();
    await app.close();
  });

  it("AC1: a tool that names a question role is [channel.wrong-tool]", async () => {
    @Tool({
      name: "limit-tool",
      description: "d",
      input: PurchaseQuestionDto,
      output: PurchasePlacedDto,
      approval: SpendingLimitQuestionExternalTask,
    })
    class LimitTool {
      execute(): Promise<PurchasePlacedDto> {
        return Promise.resolve({ status: "ok" });
      }
    }
    @Agent({
      name: "limit-agent",
      description: "d",
      prompt: inline("p"),
      model: "test/m",
      input: { message: WorkflowStartTextDto },
      output: PurchasePlacedDto,
      tools: [LimitTool],
    })
    class LimitAgent {}
    @Workflow({
      name: "tool-question-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(PurchaseWorkflowStart).toAgent(LimitAgent).toFinish(PurchaseWorkflowFinish)],
    })
    class ToolQuestionWorkflow {}
    const { channel } = questionRole("unused-external-task");
    @Application({
      name: "tool-question-application",
      version: "1.0.0",
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
            "spending-limit-question-external-task is an external task, it approves no tool — ask it with .toExternalTask(SpendingLimitQuestionExternalTask)",
          ),
        }),
      ]),
    );
  });
});

describe("#659 AC4: a question role's interpreter", () => {
  it("AC4: a decision model cannot read a question's answer: [channel-interpreter.decision-model]", async () => {
    @ChannelInterpreter({
      name: "jev-limit-reply-interpreter",
      description: "d",
      model: "typesafe/jev-1.13",
      modelProvider: TestDecisionsModelProvider,
    })
    class JevLimitReplyInterpreter {}
    const { role, channel } = questionRole("jev-limit-external-task", JevLimitReplyInterpreter);

    expect(await violationsOf(askingApplication("jev", role, [channel]))).toEqual([
      expect.objectContaining({
        code: "channel-interpreter.decision-model",
        message: expect.stringContaining(
          "TestDecisionsModelProvider is a decisions provider — it answers only yes / no (approved), but external task jev-limit-external-task asks for SpendingLimitAnswerDto",
        ),
      }),
    ]);
  });

  it("AC4: a chat model interpreter assembles", async () => {
    @ChannelInterpreter({
      name: "chat-limit-reply-interpreter",
      description: "d",
      model: "test/m",
    })
    class ChatLimitReplyInterpreter {}
    const { role, channel } = questionRole("chat-limit-external-task", ChatLimitReplyInterpreter);

    const app = await assemble(askingApplication("chat", role, [channel]));
    expect(app.warnings).toEqual(
      // a question can pause: the in-memory pause store is named (#659 asks through the pause seam)
      expect.arrayContaining([expect.stringContaining("[application.in-memory-pauses]")]),
    );
    await app.close();
  });
});
