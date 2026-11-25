import { compareNames } from "../llm/canonical-order.js";
import type { DecisionQuestion } from "../llm/decisions.js";
import { createJevClient } from "../llm/jev-client.js";
import type { ModelCapabilities } from "./capabilities.js";
import type { ModelInputKind } from "./content.js";
import type { DriverDecisionRequest, ProviderConnection, ProviderHandler } from "./handler.js";

import {
  defineModelDriver,
  type ChatModelDriver,
  type DecisionsModelDriver,
  type DriverConnectionSettings,
  type TextSetting,
} from "./model-driver.js";
import { ModelKind } from "./model-kind.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider.js";
import type { OpenRouterRouting } from "./openrouter-routing.js";
import { OpenRouterProvider, type OpenRouterFields } from "./openrouter.provider.js";
import type { SecretRef, OptionalSecretRef } from "../environments/env-ref.js";

/** OpenRouter's API, the default of `OpenRouterDriver`. */
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

/** What `OpenAiCompatibleDriver` takes: the connection, and fields added to every request body. */
export interface OpenAiCompatibleDriverOptions extends DriverConnectionSettings {
  /** Fields the server takes besides the OpenAI ones, sent with every request (`{ top_k: 40 }`). */
  readonly requestFields?: Readonly<Record<string, unknown>>;
}

/** What `OpenRouterDriver` takes: its key, and the routing OpenRouter offers on top of the OpenAI dialect. */
export interface OpenRouterDriverOptions {
  readonly apiKey: SecretRef | OptionalSecretRef;
  /** Default `https://openrouter.ai/api/v1`; a proxy or a stub otherwise. */
  readonly baseUrl?: TextSetting;
  readonly headers?: DriverConnectionSettings["headers"];
  /** The hosts and quantizations OpenRouter may route to (`provider: { only, ignore, … }`). */
  readonly routing?: OpenRouterRouting;
  /** OpenRouter's request transforms (`["middle-out"]`). */
  readonly transforms?: readonly string[];
}

/** What `DecisionsDriver` takes: the gateway, its endpoint and the models it serves. */
export interface DecisionsDriverOptions extends DriverConnectionSettings {
  /** The endpoint under the base URL; default `/alpha/decisions`. */
  readonly path?: string;
  /**
   * The decision models the gateway serves; a model outside the list fails `agboss check --models`
   * (`model.unknown-model`). Omit: any model is taken as given, text in and out.
   */
  readonly knownModels?: readonly string[];
}

/** An OpenAI-compatible server under a driver's connection: no OpenRouter-only header, the driver's own. */
class OpenAiCompatibleHandler extends OpenAiCompatibleProvider<Readonly<Record<string, unknown>>> {
  override readonly requestFields: Readonly<Record<string, unknown>>;

  constructor(requestFields: Readonly<Record<string, unknown>>) {
    super();
    this.requestFields = requestFields;
  }

  protected override headersOf(connection: ProviderConnection): Readonly<Record<string, string>> {
    return { ...connection.headers };
  }
}

/** OpenRouter under a driver's connection: its dialect and its `X-Title`, then the driver's headers. */
class OpenRouterHandler extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields;

  constructor(requestFields: OpenRouterFields) {
    super();
    this.requestFields = requestFields;
  }

  protected override headersOf(connection: ProviderConnection): Readonly<Record<string, string>> {
    return { "X-Title": "AGBoss", ...connection.headers };
  }
}

/** A decisions gateway: `decide` over the driver's endpoint, choice options sorted by name. */
class DecisionsHandler implements ProviderHandler {
  constructor(
    private readonly path: string | undefined,
    private readonly knownModels: readonly string[] | undefined,
  ) {}

  decide({ connection, ...decision }: DriverDecisionRequest): Promise<unknown> {
    const questions = Object.fromEntries(
      Object.entries(decision.questions).map(([id, question]) => [id, sortedOptions(question)]),
    );
    const client = createJevClient(
      {
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        path: this.path,
        headers: connection.headers,
      },
      connection.fetch,
    );
    return client({ ...decision, questions });
  }

  capabilities(model: string): Promise<ModelCapabilities | undefined> {
    if (this.knownModels !== undefined && !this.knownModels.includes(model))
      return Promise.resolve(undefined);
    return Promise.resolve({ model, inputs: decisionInputsOf(model) });
  }
}

/** A choice question's options sorted by name; yes/no and score questions as asked (a scale is ordered). */
function sortedOptions(question: DecisionQuestion): DecisionQuestion {
  if (question.type !== "choice") return question;
  const criteria = Object.entries(question.criteria).sort(([a], [b]) => compareNames(a, b));
  return { ...question, criteria: Object.fromEntries(criteria) };
}

/** Decision models that read images besides text: Luna, pplx-decider, Clef. */
const IMAGE_DECISION_MODEL =
  /^(?:openai\/gpt-6-luna-decisions$|perplexity\/pplx-decider|cloudflare\/clef)/;

const decisionInputsOf = (model: string): readonly ModelInputKind[] =>
  IMAGE_DECISION_MODEL.test(model) ? ["text", "image"] : ["text"];

const describesUrl = (baseUrl: TextSetting): string =>
  typeof baseUrl === "string" ? baseUrl : `$${baseUrl.variable}`;

/**
 * Any OpenAI-compatible chat server — OpenAI, LiteLLM, vLLM, Ollama, Groq, DeepSeek, Together: the
 * Chat Completions API and `GET /models`, nothing OpenRouter-only on the wire.
 */
export function OpenAiCompatibleDriver(options: OpenAiCompatibleDriverOptions): ChatModelDriver {
  const { requestFields = {}, ...settings } = options;
  return defineModelDriver<ModelKind.Chat>({
    kind: ModelKind.Chat,
    dialect: "openai-compatible",
    settings,
    requestFields,
    createHandler: () => new OpenAiCompatibleHandler(requestFields),
    describes: `openai-compatible ${describesUrl(settings.baseUrl)}`,
  });
}

/** OpenRouter as a dialect: its reasoning and caching fields, the cost in every answer, host routing. */
export function OpenRouterDriver(options: OpenRouterDriverOptions): ChatModelDriver {
  const { routing, transforms, baseUrl = OPENROUTER_API_URL, ...rest } = options;
  const requestFields: OpenRouterFields = {
    ...(routing === undefined ? {} : { provider: routing }),
    ...(transforms === undefined ? {} : { transforms }),
  };
  return defineModelDriver<ModelKind.Chat>({
    kind: ModelKind.Chat,
    dialect: "openrouter",
    settings: { ...rest, baseUrl },
    requestFields: { ...requestFields },
    createHandler: () => new OpenRouterHandler(requestFields),
    describes: `openrouter ${describesUrl(baseUrl)}`,
  });
}

/** A gateway of decision models: choice, yes/no and score questions answered with calibrated confidence. */
export function DecisionsDriver(options: DecisionsDriverOptions): DecisionsModelDriver {
  const { path, knownModels, ...settings } = options;
  return defineModelDriver<ModelKind.Decisions>({
    kind: ModelKind.Decisions,
    dialect: "decisions",
    settings,
    requestFields: { ...(path === undefined ? {} : { path }) },
    createHandler: () => new DecisionsHandler(path, knownModels),
    describes: `decisions ${describesUrl(settings.baseUrl)}`,
  });
}
