/**
 * #941 AC1 (the assembly rules of a deadline): `[channel.expires-in-invalid]` for a role's, a tool's
 * or a question step's `expiresIn` that is no positive finite duration of at least `seconds(1)`,
 * `[tool.expires-in-without-channel]`, `[question.expires-in-conflict]` for two edges to one
 * question with different values — and what is valid assembles.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { createAppWith } from "../../src/application/create-app.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { Channel, Tool, type ToolHandler } from "../../src/components/decorators.js";
import type { Class } from "../../src/components/injection.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { FlowSyntaxError } from "../../src/flow/flow-syntax-error.js";
import { StepFailedError } from "../../src/graph/errors.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { hours, seconds, type Milliseconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../flow/fixtures/dtos.js";
import { question, start, toQuestion } from "../flow/fixtures/paths.js";
import {
  DraftQuestionAction,
  PlacePurchaseAction,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  QuestionInbox,
  SpendingLimitAnswerDto,
} from "../flow/fixtures/questions.fixture.js";

const assemble = (application: Class) =>
  createAppWith(application, { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) });

/** Assembles `application` and stops it at once. */
const assembles = async (application: Class): Promise<void> => {
  const app = await assemble(application);
  await app.close();
};

const violationsOf = async (
  application: Class,
): Promise<readonly { code: string; message: string }[]> => {
  const error: unknown = await assemble(application).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GraphRuleError);
  return (error as GraphRuleError).violations;
};

/** A question role with `expiresIn` and its channel. */
function roleWith(name: string, expiresIn: Milliseconds | undefined) {
  @ChannelRole({
    name,
    description: "d",
    ask: PurchaseQuestionDto,
    answer: SpendingLimitAnswerDto,
    answerer: PauseAnswerer.ThreadOwner,
    maxVisits: 2,
    ...(expiresIn === undefined ? {} : { expiresIn }),
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

/**
 * A workflow asking `role` on its main path with `options[0]`, and — with a second entry — again on
 * the side path of its placing step with `options[1]` (one node, two edges).
 */
function askingApplication(
  name: string,
  role: Class,
  channel: Class,
  options: readonly unknown[],
): Class {
  const [main, again] = options;
  const asked = start(PurchaseWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAction(DraftQuestionAction)
    .returns(PurchaseQuestionDto)
    .toQuestion(role, main);
  const placed = (path: typeof asked) =>
    path
      .returns(SpendingLimitAnswerDto, { about: PurchaseQuestionDto })
      .toAction(PlacePurchaseAction);
  const flow =
    options.length < 2
      ? [placed(asked).returns(PurchasePlacedDto).toFinish(PurchaseWorkflowFinish)]
      : [
          asked,
          placed(question(role))
            .onError(StepFailedError, toQuestion(role, again))
            .returns(PurchasePlacedDto)
            .toFinish(PurchaseWorkflowFinish),
        ];
  @Workflow({ name: `${name}-workflow`, version: "1.0.0", flow, providers: [QuestionInbox] })
  class AskingWorkflow {}
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [AskingWorkflow],
    budgets: TEST_BUDGETS,
    providers: [channel],
  })
  class AskingApplication {}
  return AskingApplication;
}

describe("#941 AC1: a role's expiresIn", () => {
  it("[channel.expires-in-invalid]: under seconds(1), zero, not finite, not a number", async () => {
    for (const [index, bad] of [seconds(0.5), seconds(0), Infinity, Number.NaN, "1h"].entries()) {
      const { role, channel } = roleWith(`bad-${String(index)}-question`, bad as never);

      expect(
        await violationsOf(askingApplication(`bad${String(index)}`, role, channel, [undefined])),
      ).toEqual([
        expect.objectContaining({
          code: "channel.expires-in-invalid",
          message: expect.stringContaining(`bad-${String(index)}-question`),
        }),
      ]);
    }
  });

  it("seconds(1) and hours(24) assemble", async () => {
    for (const [index, good] of [seconds(1), hours(24)].entries()) {
      const { role, channel } = roleWith(`good-${String(index)}-question`, good);

      await expect(
        assembles(askingApplication(`good${String(index)}`, role, channel, [undefined])),
      ).resolves.toBeUndefined();
    }
  });
});

describe("#941 AC1: a question step's expiresIn", () => {
  it("[channel.expires-in-invalid] names the step", async () => {
    const { role, channel } = roleWith("step-bad-question", hours(1));

    expect(
      await violationsOf(
        askingApplication("stepbad", role, channel, [{ expiresIn: seconds(0.2) }]),
      ),
    ).toEqual([
      expect.objectContaining({
        code: "channel.expires-in-invalid",
        message: expect.stringContaining("step-bad-question"),
      }),
    ]);
  });

  it("[question.expires-in-conflict]: two edges to one question with different values", async () => {
    const { role, channel } = roleWith("conflict-question", hours(1));

    expect(
      await violationsOf(
        askingApplication("conflict", role, channel, [
          { expiresIn: hours(2) },
          { expiresIn: hours(3) },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({
        code: "question.expires-in-conflict",
        message: expect.stringContaining("conflict-question"),
      }),
    ]);
  });

  it("two edges with the same value assemble", async () => {
    const { role, channel } = roleWith("same-question", hours(1));

    await expect(
      assembles(
        askingApplication("same", role, channel, [
          { expiresIn: hours(2) },
          { expiresIn: hours(2) },
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it("an expiresIn that is no duration is a flow syntax error at the call", () => {
    const { role } = roleWith("syntax-question", undefined);
    const path = start(PurchaseWorkflowStart).returns(WorkflowStartTextDto);

    expect(() => path.toQuestion(role, { expiresIn: "soon" })).toThrow(FlowSyntaxError);
    expect(() => path.toQuestion(role, 5)).toThrow(FlowSyntaxError);
  });
});

describe("#941 AC1: a tool's expiresIn", () => {
  const toolApplication = (
    name: string,
    channel: Class | undefined,
    expiresIn: Milliseconds,
  ): Class => {
    @Tool({
      name: `${name}-tool`,
      description: "d",
      input: PurchaseQuestionDto,
      output: PurchasePlacedDto,
      ...(channel === undefined ? {} : { channel }),
      expiresIn,
    })
    class SomeTool implements ToolHandler<PurchaseQuestionDto, PurchasePlacedDto> {
      run(): Promise<PurchasePlacedDto> {
        return Promise.resolve({ status: "ok" });
      }
    }
    @Agent({
      name: `${name}-agent`,
      description: "d",
      prompt: "p",
      model: "test/m",
      input: { message: WorkflowStartTextDto },
      output: PurchasePlacedDto,
      tools: [SomeTool],
    })
    class SomeAgent {}
    @Workflow({
      name: `${name}-workflow`,
      version: "1.0.0",
      flow: [
        start(PurchaseWorkflowStart)
          .returns(WorkflowStartTextDto)
          .toAgent(SomeAgent)
          .returns(PurchasePlacedDto)
          .toFinish(PurchaseWorkflowFinish),
      ],
    })
    class SomeWorkflow {}
    @Application({
      name: `${name}-application`,
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [SomeWorkflow],
      budgets: TEST_BUDGETS,
      providers: channel === undefined ? [] : [],
    })
    class SomeApplication {}
    return SomeApplication;
  };

  it("[tool.expires-in-without-channel]", async () => {
    expect(await violationsOf(toolApplication("nochannel", undefined, hours(1)))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "tool.expires-in-without-channel" }),
      ]),
    );
  });
});
