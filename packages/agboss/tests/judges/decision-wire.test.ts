/**
 * #226 on the wire: the production gateway sends decisions to OpenRouter's Decisions API
 * (`POST {base}/alpha/decisions`, `{ model, state, questions }`) and validates every answer —
 * through `createApp` with the providers' HTTP side stubbed.
 */
import { describe, expect, it } from "vitest";
import type { AppDepsOptions } from "../../src/app/app-deps.js";
import { appWithKeys } from "../models/gateway.js";
import { Decision } from "../../src/index.js";
import { DecisionRequestError, DecisionResponseError } from "../../src/errors.js";
import { createModelGateway } from "../../src/llm/gateway.js";
import { resolutionProblems } from "../../src/models/check.js";
import { modelUsesOf } from "../../src/models/uses.js";
import { DEFAULT_MODEL_PROVIDERS, directoryOf } from "../../src/models/workflow-models.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { completion, providerStub, toolCallCompletion, type StubReply } from "../models/stub.js";
import { answerToolName } from "../../src/flow/analyse/rules/models.js";
import { LUNA, PNG, ImageDeskApplication } from "./fixtures/decision-judged.workflow.js";
import { TaskStart } from "./fixtures/judged.workflow.js";
import { AskDto, LunaRoutedApplication } from "./fixtures/wrong-kind.workflow.js";
import { execute } from "../helpers/flow.js";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** A Decisions API response, as OpenRouter documents it. */
const decided = (answers: Record<string, unknown>, cost: number): StubReply => ({
  body: {
    model: LUNA,
    answers,
    usage: { input_tokens: 120, output_tokens: 3, cost },
    id: "dec-1",
    provider: "OpenAI",
  },
});

const wired = (stub: ReturnType<typeof providerStub>): AppDepsOptions => ({
  processEnv: {},
  providerFetch: stub.fetch,
});

const MODELS = [{ id: "local/llama" }];

const decisionRequests = (stub: ReturnType<typeof providerStub>) =>
  stub.requests.filter((request) => request.url === DECISIONS_URL);

describe("AC4: an image part in state is sent as a top-level image_url item", () => {
  it("the judge's state goes out as text and image parts; its exact cost is under its caller", async () => {
    const stub = providerStub(
      [completion("A rising chart."), decided({ matches: { type: "noul", noul: 0.93 } }, 0.0004)],
      MODELS,
    );
    const app = await appWithKeys(ImageDeskApplication, wired(stub));

    const result = await execute(app, TaskStart, { text: "describe the chart" });
    await app.close();

    expect(result.output).toEqual({ text: "A rising chart." });
    const [sent] = decisionRequests(stub);
    expect(sent?.authorization).toBe("Bearer k");
    expect(sent?.body).toEqual({
      model: LUNA,
      state: [
        "Does the chart match the reply?",
        { type: "image_url", image_url: { url: PNG, detail: "low" } },
        "A rising chart.",
      ],
      questions: { matches: { type: "noul", instructions: "The reply describes the chart" } },
    });
    const judged = result.spend.trace.filter((line) => line.caller === "judge:looks-right");
    expect(judged).toMatchObject([
      { model: LUNA, costUsd: 0.0004, costSource: "api", inputTokens: 120, outputTokens: 3 },
    ]);
  });

  it("a malformed answer fails the run with model.decision.invalid-response", async () => {
    const stub = providerStub(
      [completion("A rising chart."), decided({ matches: { type: "choice", choice: "yes" } }, 0)],
      MODELS,
    );
    const app = await appWithKeys(ImageDeskApplication, wired(stub));

    const run = execute(app, TaskStart, { text: "describe the chart" });

    await expect(run).rejects.toMatchObject({
      code: "step.agent",
      cause: { code: "model.decision.invalid-response" },
    });
    await app.close();
  });
});

describe("AC3: a router on openai/gpt-6-luna-decisions decides through the Decisions API", () => {
  it("one choice question over its routes, options sorted; its answer routes the run", async () => {
    const stub = providerStub(
      [
        toolCallCompletion(answerToolName(AskDto), { text: "A coding ask." }),
        decided(
          {
            route: {
              type: "choice",
              choice: "coder-agent",
              probabilities: { "coder-agent": 0.9 },
              confidence: 0.9,
            },
          },
          0.0002,
        ),
        completion("Done: the fix."),
      ],
      MODELS,
    );
    const app = await appWithKeys(LunaRoutedApplication, wired(stub));

    const result = await execute(app, TaskStart, { text: "fix my build" });
    await app.close();

    expect(result.path).toEqual([
      "task-workflow-start",
      "intake-agent",
      "triage-router",
      "coder-agent",
      "reply-workflow-finish",
    ]);
    expect(result.output).toEqual({ text: "Done: the fix." });
    const [sent] = decisionRequests(stub);
    expect(sent?.body).toMatchObject({ model: LUNA, questions: { route: { type: "choice" } } });
    const criteria = Object.keys(
      (sent?.body?.questions as { route: { criteria: object } }).route.criteria,
    );
    expect(criteria).toEqual([...criteria].sort());
    expect(result.spend.trace).toContainEqual(
      expect.objectContaining({ caller: "router:triage-router", model: LUNA, costUsd: 0.0002 }),
    );
  });
});

describe("the default gateway's decide", () => {
  const asked: unknown[] = [];
  const gateway = createModelGateway({
    chatModel: () => {
      throw new Error("no chat");
    },
    jevClient: (request) => {
      asked.push(request);
      return Promise.resolve({
        model: LUNA,
        answers: {
          tone: {
            type: "choice",
            choice: "neutral",
            probabilities: { neutral: 0.8, pushy: 0.2 },
            confidence: 0.8,
          },
          quality: {
            type: "score",
            score: 3,
            probabilities: { "3": 1 },
            legend: { "3": "?" },
            confidence: 1,
          },
        },
        usage: { cost: 0.0001 },
      });
    },
  });

  it("refuses more than 200 questions before any call", async () => {
    const questions = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`q${String(i)}`, Decision.noul("Is it?")]),
    );

    await expect(
      gateway.decide({ caller: "judge:x", model: LUNA, request: { state: "s", questions } }),
    ).rejects.toBeInstanceOf(DecisionRequestError);
    expect(asked).toEqual([]);
  });

  it("refuses an answer outside its question (a score past the levels)", async () => {
    const decision = gateway.decide({
      caller: "judge:x",
      model: LUNA,
      request: {
        state: "s",
        questions: {
          tone: Decision.choice("Tone", { neutral: null, pushy: null }),
          quality: Decision.score("Quality", ["low", "mid", "high"]),
        },
      },
    });

    await expect(decision).rejects.toBeInstanceOf(DecisionResponseError);
    await expect(decision).rejects.toThrow(/"quality": score 3 is past its 3 levels/u);
  });
});

describe("the eval judge (compareProfiles) is defaults.router: any decision model, or a clear startup error", () => {
  const config = (router: { kind: "jev" } | { kind: "llm" }) => ({
    name: "c",
    version: "1",
    defaults: {
      models: { temperature: 0, maxTokens: 100 },
      router: { ...router, model: LUNA },
      uncompactedTurns: 1,
    },
    agents: { a: { model: "x/y", description: "a" } },
  });

  it("a decision model decides through the Decisions API; as a chat model it is model.unserved", () => {
    const directory = directoryOf(DEFAULT_MODEL_PROVIDERS);

    expect(resolutionProblems(modelUsesOf(config({ kind: "jev" }), []), directory)).toEqual([]);
    expect(resolutionProblems(modelUsesOf(config({ kind: "llm" }), []), directory)).toMatchObject([
      { code: "model.unserved", key: "defaults.router", model: LUNA },
    ]);
  });
});
