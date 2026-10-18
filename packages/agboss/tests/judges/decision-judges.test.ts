/**
 * #226: decision models are first-class — a judge decides on any decision model with typed answers
 * (`judgeModel.decide`, `Decision.choice / noul / score / image`), its spend under `judge:<name>`;
 * routers route on any decision model; the wrong call for a model's kind is a `ModelKindError`.
 */
import { describe, expect, it } from "vitest";
import { AgentFailedError, DecisionRequestError, ModelKindError } from "../../src/errors.js";
import { Decision } from "../../src/index.js";
import { decideWith, replyWith, routeTo, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import {
  AnswerGrounded,
  LUNA,
  Writer,
  DecisionDeskApplication,
} from "./fixtures/decision-judged.workflow.js";
import { Reply, TaskStart } from "./fixtures/judged.workflow.js";
import {
  ChatDecider,
  ChatJudged,
  Coder,
  DecisionChatter,
  DecisionJudged,
  AskDto,
  Intake,
  Triage,
  ChatDeciderDeskApplication,
  DecisionChatterDeskApplication,
  LunaRoutedApplication,
} from "./fixtures/wrong-kind.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const task = { text: "find a TS job" };

describe("AC1: a judge on a decision model", () => {
  const test = testWith(DecisionDeskApplication);

  test("passes a reply from its typed answers; it was asked the state and the three questions", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer).thenReturn(replyWith("Acme is hiring a TS engineer."));
    mockLlm(AnswerGrounded).thenReturn(decideWith({ grounded: 0.9, tone: "neutral", quality: 2 }));

    const result = await execute(app, TaskStart, task);

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "Acme is hiring a TS engineer." });
    expect(mockLlm(AnswerGrounded).onlyRequest).toMatchObject({
      kind: "decide",
      state: {
        task: expect.stringContaining('"text": "find a TS job"') as string,
        reply: "Acme is hiring a TS engineer.",
      },
      questions: {
        grounded: { type: "noul" },
        tone: {
          type: "choice",
          criteria: { neutral: "Plain, factual", pushy: "Sells or pressures" },
        },
        quality: { type: "score", criteria: ["useless", "partial", "complete"] },
      },
    });
  });

  test("rejects from its answers; the feedback reaches the agent's retry", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer)
      .thenReturn(replyWith("Apply now, best job ever!"))
      .thenReturn(replyWith("Acme is hiring a TS engineer."));
    mockLlm(AnswerGrounded)
      .thenReturn(decideWith({ grounded: 0.9, tone: "pushy", quality: "partial" }))
      .thenReturn(decideWith({ grounded: 0.95, tone: "neutral", quality: "complete" }));

    const result = await execute(app, TaskStart, task);

    expect(result.output).toEqual({ text: "Acme is hiring a TS engineer." });
    const retry = mockLlm(Writer).lastRequest;
    const said =
      retry.kind === "chat" ? retry.messages.map((line) => JSON.stringify(line.text)) : [];
    expect(said.at(-1)).toContain("[answer-grounded] Only state facts from the task, neutrally.");
  });

  test("a scripted answer that does not fit its question fails the test", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer).thenReturn(replyWith("Acme is hiring."));
    mockLlm(AnswerGrounded).thenReturn(decideWith({ grounded: 0.9, tone: "rude", quality: 2 }));

    await expect(execute(app, TaskStart, task)).rejects.toThrow(
      /test\.wrong-script: decideWith\(…\) for AnswerGrounded: "tone" is a choice of neutral, pushy/u,
    );
  });
});

describe("AC2: decision spend is in the cost report under the judge's caller", () => {
  const test = testWith(DecisionDeskApplication);

  test("each decision's cost, under judge:answer-grounded on the decision model (review)", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Writer).thenReturnAlways(replyWith("Acme is hiring.", { cost: usd(0.002) }));
    mockLlm(AnswerGrounded)
      .thenReturn(decideWith({ grounded: 0.2, tone: "neutral", quality: 0 }, { cost: usd(0.0003) }))
      .thenReturn(
        decideWith({ grounded: 0.9, tone: "neutral", quality: 2 }, { cost: usd(0.0004) }),
      );

    const result = await execute(app, TaskStart, task);

    const judged = result.spend.trace.filter((line) => line.caller === "judge:answer-grounded");
    expect(judged.map((line) => [line.model, line.costUsd])).toEqual([
      [LUNA, 0.0003],
      [LUNA, 0.0004],
    ]);
    expect(result.spend.byCategory.review).toBeCloseTo(0.0007, 8);
    expect(result.spend.totalUsd).toBeCloseTo(0.0047, 8);
  });
});

describe("AC3: a router on openai/gpt-6-luna-decisions routes", () => {
  const test = testWith(LunaRoutedApplication);

  test("its scripted decision picks the route", async ({ app, mockLlm }) => {
    mockLlm(Intake).thenReturn(replyWith(AskDto, { text: "A coding ask." }));
    mockLlm(Triage).thenReturn(routeTo(Coder));
    mockLlm(Coder).thenReturn(replyWith("Done: the fix."));

    const result = await execute(app, TaskStart, { text: "fix my build" });

    expect(result).toFollowPath([TaskStart, Intake, Triage, Coder, Reply]);
    expect(result.output).toEqual({ text: "Done: the fix." });
  });
});

describe("AC5: the wrong call for a model's kind is a ModelKindError", () => {
  const chatDecider = testWith(ChatDeciderDeskApplication);

  chatDecider("decide on a chat model", async ({ app, mockLlm }) => {
    mockLlm(ChatJudged).thenReturn(replyWith("Fine."));

    const run = execute(app, TaskStart, task);

    await expect(run).rejects.toBeInstanceOf(AgentFailedError);
    await expect(run).rejects.toMatchObject({
      cause: { code: "model.wrong-kind", details: { model: "local/judge", call: "decide" } },
    });
    await expect(
      run.catch((error: unknown) => (error instanceof AgentFailedError ? error.cause : error)),
    ).resolves.toBeInstanceOf(ModelKindError);
    expect(mockLlm(ChatDecider).requests).toEqual([]);
  });

  const decisionChatter = testWith(DecisionChatterDeskApplication);

  decisionChatter("invoke on a decision model", async ({ app, mockLlm }) => {
    mockLlm(DecisionJudged).thenReturn(replyWith("Fine."));

    const run = execute(app, TaskStart, task);

    await expect(run).rejects.toMatchObject({
      code: "step.agent",
      cause: { code: "model.wrong-kind", details: { model: LUNA, call: "invoke" } },
    });
    expect(mockLlm(DecisionChatter).requests).toEqual([]);
  });
});

describe("Decision builders refuse what the Decisions API would", () => {
  it.each([
    ["an image that is not a png/jpeg/webp data URL", () => Decision.image("https://x.test/a.png")],
    ["a choice of one option", () => Decision.choice("Pick", { only: null })],
    ["a score of one level", () => Decision.score("Rate", ["only"])],
  ])("%s", (_, build) => {
    expect(build).toThrow(DecisionRequestError);
  });
});
