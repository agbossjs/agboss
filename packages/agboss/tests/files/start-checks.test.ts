/**
 * #899 §4: what the files of an agent need of its models, checked at start against what the provider
 * says they take — the agent's model, the transcriber's, a fallback target — strictly for types the
 * developer named, narrowing a defaulted set.
 */
import { describe, expect, it } from "vitest";
import type { AgentsConfigOf } from "../../src/config/types.js";
import { narrowedTypesOf } from "../../src/files/file-needs.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
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
import { providerStub } from "../models/stub.js";

const filesOf = (options: Parameters<typeof ModelFiles.of>[0], hasPiiPolicy = false) =>
  resolvedFilesOf({
    agent: ModelFiles.of(options).options,
    defaults: undefined,
    skills: [],
    a2aFiles: undefined,
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
      ["files.transcriber.reader-agent", "text/only", "model.unsupported-input"],
      ["files.transcriber.reader-agent", "text/only", "model.unsupported-input"],
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
  promptCaching: PromptCaching.whereSupported({
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt],
  }),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 3, window: minutes(1), openFor: seconds(30) },
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
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: {
    failureThreshold: 3,
    window: minutes(1),
    openFor: seconds(30),
    fallback: VisionlessBackup,
    fallbackModels: { "primary/vision": "backup/text" },
  },
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
