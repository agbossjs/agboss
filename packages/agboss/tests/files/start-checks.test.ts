/**
 * #899 §4: what the files of an agent need of its models, checked at start against what the provider
 * says they take — the agent's model, the transcriber's, a fallback target — strictly for types the
 * developer named, narrowing a defaulted set.
 */
import { describe, expect, it } from "vitest";
import type { AgentsConfigOf } from "../../src/config/types.js";
import { withNarrowedFiles } from "../../src/files/assemble-files.js";
import { narrowedTypesOf } from "../../src/files/file-needs.js";
import { guardrailReadersOf } from "../../src/files/file-readers.js";
import { NodeKind } from "../../src/flow/ast.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { checkedModelUses } from "../../src/models/check.js";
import {
  CachedPart,
  CacheRetention,
  DecisionsModelProvider,
  ModelCost,
  ModelProvider,
  OpenRouterProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type OpenRouterFields,
} from "../../src/models/index.js";
import { ModelProviderDirectory } from "../../src/models/resolve.js";
import { modelUsesOf } from "../../src/models/uses.js";
import { minutes, seconds } from "../../src/units/index.js";
import { TestOpenRouterProvider } from "../models/providers.fixture.js";
import { FetchedDto } from "./reader.factory.js";
import { providerStub } from "../models/stub.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";
import { DEFAULT_FILE_LIMITS } from "../../src/files/file-policy.js";

const filesOf = (options: Parameters<typeof ModelFiles.of>[0], hasPiiPolicy = false) =>
  resolvedFilesOf({
    agent: ModelFiles.of(options).options,
    defaults: undefined,
    limits: DEFAULT_FILE_LIMITS,
    hasPiiPolicy,
  });

const configOf = (model: string, files: ReturnType<typeof filesOf>): AgentsConfigOf<string> => ({
  name: "w",
  version: "1",
  defaults: { models: { temperature: 0, maxTokens: 100 }, uncompactedTurns: 1 },
  agents: { "reader-agent": { model, description: "reads", files } },
});

const CATALOG = [
  { id: "text/only", architecture: { input_modalities: ["text"] } },
  { id: "vision/image", architecture: { input_modalities: ["text", "image"] } },
  { id: "vision/full", architecture: { input_modalities: ["text", "image", "file"] } },
  { id: "silent/model" },
];

const directoryOf = () =>
  ModelProviderDirectory.of([TestOpenRouterProvider, DecisionsModelProvider]);

const check = (model: string, files: ReturnType<typeof filesOf>, extra: object = {}) =>
  checkedModelUses(modelUsesOf(configOf(model, files), [], extra), directoryOf(), {
    env: {},
    send: providerStub([], CATALOG).fetch,
  });

describe("AC1: a model that cannot take a file's type stops the start (when the provider reports input types)", () => {
  it("AC1: start error with inputs: a text-only model, PNG and PDF named → [model.unsupported-input] for each kind", async () => {
    const files = filesOf({
      allowedMediaTypes: ["image/png", "application/pdf"],
      views: [FileView.Original],
    });

    const { problems } = await check("text/only", files, { builtInFileModels: false });

    expect(
      problems.map((problem) => [problem.code, problem.key, problem.value, problem.model]),
    ).toEqual([
      ["model.unsupported-input", "agents.reader-agent", "image/png (original)", "text/only"],
      ["model.unsupported-input", "agents.reader-agent", "application/pdf (original)", "text/only"],
    ]);
  });

  it("AC1: a model that takes images passes a PNG and fails a PDF", async () => {
    const png = filesOf({ allowedMediaTypes: ["image/png"] });
    const both = filesOf({ allowedMediaTypes: ["image/png", "application/pdf"] });

    expect((await check("vision/image", png, { builtInFileModels: false })).problems).toEqual([]);
    expect((await check("vision/image", both, { builtInFileModels: false })).problems).toHaveLength(
      1,
    );
  });

  it("AC1: absent inputs → unchecked at start", async () => {
    const files = filesOf({ allowedMediaTypes: ["application/pdf"] });

    expect((await check("silent/model", files, { builtInFileModels: false })).problems).toEqual([]);
  });

  it("AC1: a defaulted set starts on an image-only model, narrowed to the kinds it takes", async () => {
    const files = filesOf({});

    const { problems, inputs } = await check("vision/image", files, { builtInFileModels: false });

    expect(problems).toEqual([]);
    expect(inputs.get("agents.reader-agent")).toEqual(["text", "image"]);
    expect(narrowedTypesOf(files, ["text", "image"])).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]);
  });

  it("AC5: the built-in transcriber's model is a strict use of its own: a text-only transcription model fails the start", async () => {
    const files = filesOf({ views: [FileView.Transcription] });
    const config = configOf("vision/full", { ...files, transcriptionModel: "text/only" });

    const { problems } = await checkedModelUses(modelUsesOf(config, []), directoryOf(), {
      env: {},
      send: providerStub([], CATALOG).fetch,
    });

    // default types: images and PDF are read raw by the transcriber's model
    expect(problems.map((problem) => [problem.key, problem.model, problem.code])).toEqual([
      ["fileTranscribers.reader-agent", "text/only", "model.unsupported-input"],
      ["fileTranscribers.reader-agent", "text/only", "model.unsupported-input"],
    ]);
  });

  it("AC5: with the application's own transcriber the built-in's model is no use at all", () => {
    const files = filesOf({ views: [FileView.Transcription] });

    const uses = modelUsesOf(configOf("vision/full", files), [], { builtInFileModels: false });

    expect(uses.map((use) => use.key)).toEqual(["agents.reader-agent"]);
  });
});

@ModelProvider({
  name: "visionless-backup-model-provider",
  description: "A backup that reads text only",
  serves: [/^backup\//],
  baseUrl: "http://backup.test/v1",
  apiKey: "backupApiKey",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.on({
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt],
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 3,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
})
class VisionlessBackup extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}

@ModelProvider({
  name: "primary-model-provider",
  description: "A primary with a fallback",
  serves: [/^primary\//],
  baseUrl: "http://primary.test/v1",
  apiKey: "openRouterApiKey",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 3,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
  fallback: { provider: VisionlessBackup, models: { "primary/vision": "backup/text" } },
})
class PrimaryWithFallback extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}

describe("AC1: every fallbackModels target must read what the primary reads", () => {
  it("AC1: a fallback model without image is a start error naming the fallback model", async () => {
    const files = filesOf({ allowedMediaTypes: ["image/png"] });
    const catalog = [
      { id: "primary/vision", architecture: { input_modalities: ["text", "image"] } },
      { id: "backup/text", architecture: { input_modalities: ["text"] } },
    ];

    const { problems } = await checkedModelUses(
      modelUsesOf(configOf("primary/vision", files), [], { builtInFileModels: false }),
      ModelProviderDirectory.of([PrimaryWithFallback, VisionlessBackup]),
      { env: {}, send: providerStub([], catalog).fetch },
    );

    expect(problems).toEqual([
      expect.objectContaining({
        code: "model.unsupported-input",
        model: "backup/text",
        value: "image/png (original)",
      }),
    ]);
  });

  it("AC1: a defaulted set narrows to what the primary AND its fallback read", async () => {
    const catalog = [
      { id: "primary/vision", architecture: { input_modalities: ["text", "image"] } },
      { id: "backup/text", architecture: { input_modalities: ["text"] } },
    ];

    const { problems, inputs } = await checkedModelUses(
      modelUsesOf(configOf("primary/vision", filesOf({})), [], { builtInFileModels: false }),
      ModelProviderDirectory.of([PrimaryWithFallback, VisionlessBackup]),
      { env: {}, send: providerStub([], catalog).fetch },
    );

    expect(problems).toEqual([]);
    expect(inputs.get("agents.reader-agent")).toEqual(["text"]);
  });
});

describe("AC4: a guardrail's or a judge's model that cannot take a file's type stops the start", () => {
  const graph = { nodes: new Map() } as never;
  const guardedBy = (...names: string[]) =>
    new Map([
      ["reader-agent", { input: names.map((name) => ({ name })) as never, output: [] as never }],
    ]);

  /** A guardrail on `model` guarding the agent whose files are `files`. */
  const checkGuardrail = (
    model: string,
    files: ReturnType<typeof filesOf>,
    byElement = guardedBy("looks-guardrail"),
  ) => {
    const config = configOf("vision/full", files);
    const reads = guardrailReadersOf(config, byElement, graph).get("looks-guardrail");
    const uses = modelUsesOf(config, [], {
      builtInFileModels: false,
      guardrails: [{ name: "looks-guardrail", model, reads }],
    });
    return checkedModelUses(uses, directoryOf(), {
      env: {},
      send: providerStub([], CATALOG).fetch,
    });
  };

  it("AC4: a text-only decision model as the guardrail of an agent that reads PNGs → [model.unsupported-input]", async () => {
    const files = filesOf({ allowedMediaTypes: ["image/png"], views: [FileView.Original] });

    const { problems } = await checkGuardrail("typesafe/jev-1.13", files);

    expect(problems.map((problem) => [problem.code, problem.key, problem.value])).toEqual([
      ["model.unsupported-input", "guardrails.looks-guardrail", "image/png (original)"],
    ]);
  });

  it("AC4: a decision model with images takes png, jpeg and webp — and a gif is a start error", async () => {
    const png = filesOf({ allowedMediaTypes: ["image/png"], views: [FileView.Original] });
    const gif = filesOf({ allowedMediaTypes: ["image/gif"], views: [FileView.Original] });

    expect((await checkGuardrail("openai/gpt-6-luna-decisions", png)).problems).toEqual([]);
    const { problems } = await checkGuardrail("openai/gpt-6-luna-decisions", gif);
    expect(problems.map((problem) => [problem.key, problem.value, problem.supported])).toEqual([
      [
        "guardrails.looks-guardrail",
        "image/gif (original)",
        "takes png, jpeg and webp images, not image/gif",
      ],
    ]);
  });

  it("AC4: a decision-model guardrail and a PDF or a transcription: a PDF fails, a transcription (text) starts", async () => {
    const pdf = filesOf({ allowedMediaTypes: ["application/pdf"], views: [FileView.Original] });
    const text = filesOf({
      allowedMediaTypes: ["application/pdf"],
      views: [FileView.Transcription],
    });

    expect((await checkGuardrail("typesafe/jev-1.13", pdf)).problems).toHaveLength(1);
    expect((await checkGuardrail("typesafe/jev-1.13", text)).problems).toEqual([]);
  });

  it("AC4: a defaulted set starts on a decision-model guardrail, narrowed with the agent's own model's kinds", async () => {
    const files = filesOf({});
    const config = configOf("vision/full", files);
    const reads = guardrailReadersOf(config, guardedBy("looks-guardrail"), graph).get(
      "looks-guardrail",
    );
    const uses = modelUsesOf(config, [], {
      builtInFileModels: false,
      guardrails: [{ name: "looks-guardrail", model: "typesafe/jev-1.13", reads }],
    });

    const { problems, inputs } = await checkedModelUses(uses, directoryOf(), {
      env: {},
      send: providerStub([], CATALOG).fetch,
    });
    const narrowed = withNarrowedFiles(config, inputs, uses).agents["reader-agent"]?.files;

    expect(problems).toEqual([]);
    // text only: the agent's images and PDF wait for a guardrail that takes them
    expect(narrowed?.allowedMediaTypes).toEqual([
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]);
  });

  it("AC4: guardToolResultFiles: false — tool-result files need nothing of the input guardrails' models", async () => {
    const files = filesOf({
      sources: [FileSource.ToolResults],
      guardToolResultFiles: false,
      allowedMediaTypes: ["image/png"],
      views: [FileView.Original],
    });

    expect((await checkGuardrail("typesafe/jev-1.13", files)).problems).toEqual([]);
    const guarded = filesOf({
      sources: [FileSource.ToolResults],
      allowedMediaTypes: ["image/png"],
      views: [FileView.Original],
    });
    expect((await checkGuardrail("typesafe/jev-1.13", guarded)).problems).toHaveLength(1);
  });

  it("AC4: an output guardrail on an answer that holds files reads the same kinds", async () => {
    const files = filesOf({ allowedMediaTypes: ["image/png"], views: [FileView.Original] });
    const config = configOf("vision/full", files);
    const answering = {
      nodes: new Map([
        [
          "reader-agent",
          { declaration: { kind: NodeKind.Agent, options: { output: FetchedDto } } },
        ],
      ]),
    } as never;
    const byElement = new Map([
      ["reader-agent", { input: [] as never, output: [{ name: "answer-guardrail" }] as never }],
    ]);

    const reads = guardrailReadersOf(config, byElement, answering).get("answer-guardrail");

    expect(reads?.needs.map((need) => need.kind)).toEqual(["image"]);
    expect(guardrailReadersOf(config, byElement, graph).size).toBe(0);
  });

  it("AC4: a judge on a text-only model for an agent that reads PNGs → [model.unsupported-input]", async () => {
    const files = filesOf({ allowedMediaTypes: ["image/png"], views: [FileView.Original] });
    const config = {
      ...configOf("vision/full", files),
      judges: { "grounded-judge": { model: "text/only" } },
    };
    const agent = config.agents["reader-agent"];
    const judged = {
      ...config,
      agents: { "reader-agent": { ...agent, judges: ["grounded-judge"] } },
    };

    const { problems } = await checkedModelUses(
      modelUsesOf(judged as never, [], { builtInFileModels: false }),
      directoryOf(),
      { env: {}, send: providerStub([], CATALOG).fetch },
    );

    expect(problems.map((problem) => [problem.code, problem.key, problem.model])).toEqual([
      ["model.unsupported-input", "judges.grounded-judge", "text/only"],
    ]);
  });
});
