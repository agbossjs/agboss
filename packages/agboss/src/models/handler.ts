import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { DecisionQuestions, DecisionState } from "../llm/decisions.js";
import type { ModelCapabilities } from "./capabilities.js";
import type { PromptCaching } from "./prompt-caching.js";
import type { Reasoning } from "./reasoning.js";
import type {
  ModelProviderRequest,
  ModelProviderResponse,
  ModelProviderStream,
} from "./transport/transport.js";

/**
 * How a provider is reached: its base URL, key (when it has one) and HTTP client. A transport
 * provider's (#385) has neither base URL (`""`) nor key; its `fetch` still runs under its policies.
 */
export interface ProviderConnection {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  /** Headers its driver adds to every request (#1313), references resolved; none for the older providers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** `fetch` with the provider's timeout, retry policy and circuit breaker. */
  readonly fetch: typeof fetch;
}

/** A chat model request: the settings with reasoning and caching resolved over the provider's own. */
export interface ChatRequest {
  readonly settings: ResolvedModelSettings;
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
  readonly connection: ProviderConnection;
}

/**
 * What a provider's `decide` is asked (#1313): the decision model, what is decided about, and the
 * questions (choice, yes/no, score). Vendor-neutral: the provider puts it on its own wire.
 */
export interface ModelProviderDecisionRequest {
  readonly model: string;
  /** What the decision is made about: a text, a JSON object, or text and image parts. */
  readonly state: DecisionState;
  readonly questions: DecisionQuestions;
}

/**
 * The contract of a model provider (`@ModelProvider` class) that makes its own calls: `complete`
 * (and `stream`) for chat, `decide` for decisions, `capabilities` for what each model supports. A
 * driver provider (`OpenAiCompatibleDriver`, `OpenRouterDriver`, `DecisionsDriver`) speaks its
 * protocol itself and its class has none of these. Every policy of the gateway runs around them.
 */
export interface ModelProviderHandler {
  /** One decision (a router, guardrail, judge or interpreter on a decision model): the answers by question id. */
  readonly decide?: (request: ModelProviderDecisionRequest) => Promise<unknown>;
  /**
   * A custom transport (#385): one chat call, made by the class itself (an SDK, a gateway). Throw
   * `ModelProviderFailureError` to say what failed (a 429, a timeout, a server error).
   */
  readonly complete?: (request: ModelProviderRequest) => Promise<ModelProviderResponse>;
  /**
   * The same call, streamed (#1011): the text chunks as they come and the call's `result` (its
   * usage, cost and finish reason, #1311). Optional; a provider without it keeps its answer as one
   * `StreamEventKind.TextDelta` event at the end. Used for a call with no
   * tools bound — a text stream carries no tool call, so a call with tools goes through `complete`.
   */
  readonly stream?: (request: ModelProviderRequest) => ModelProviderStream;
  /**
   * `undefined` = the provider does not serve this model (`model.unknown-model`). A transport
   * provider without it is not checked against its models' capabilities.
   */
  readonly capabilities?: (model: string) => Promise<ModelCapabilities | undefined>;
}

/** What of a provider's routing no endpoint of a model can serve (#395 PR 6): the setting, what exists. */
export interface RoutingProblem {
  /** The routing setting that cannot be met: `provider.only: fireworks`. */
  readonly value: string;
  /** The model's endpoints as the provider lists them. */
  readonly supported: string;
}

/** A decision as a driver's handler is asked: the request and how the provider is reached. */
export interface DriverDecisionRequest extends ModelProviderDecisionRequest {
  readonly connection: ProviderConnection;
}

/**
 * What a driver's handler (#1313) speaks over a connection: a chat model (`chat`), decisions
 * (`decide`), the models it serves (`capabilities`), the host routing no endpoint serves
 * (`routingProblems`). Internal: a driver is built by `OpenAiCompatibleDriver` and the others; a
 * custom provider class is a `ModelProviderHandler`.
 */
export interface ProviderHandler extends Omit<ModelProviderHandler, "decide" | "capabilities"> {
  readonly chat?: (request: ChatRequest) => BaseChatModel;
  readonly decide?: (request: DriverDecisionRequest) => Promise<unknown>;
  readonly capabilities?: (
    model: string,
    connection: ProviderConnection,
  ) => Promise<ModelCapabilities | undefined>;
  /**
   * What of the provider's host routing no endpoint of `model` can serve (#395 PR 6: OpenRouter's
   * pinned hosts and quantizations) — asked only by `agboss check --models`, over the network.
   */
  readonly routingProblems?: (
    model: string,
    connection: ProviderConnection,
  ) => Promise<readonly RoutingProblem[]>;
}
