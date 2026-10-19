import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import {
  createJevRouter,
  createLlmRouter,
  type RouteOutcome,
  type RouteRequest,
  type RouterEngine,
} from "../routers/index.js";
import { readDecision, type DecisionOutcome } from "./decision-response.js";
import { checkDecisionRequest, type DecisionRequest } from "./decisions.js";
import type { JevClient } from "./jev-client.js";
import type { ModelFactory } from "./registry.js";
import { providerClients, type ProviderClientOptions } from "./provider-clients.js";
import type { ModelProviderDirectory } from "../models/resolve.js";
import type { ReplyInterpreterInput } from "../channels/reply-reader.js";

/** Who a chat model is for: what a substitute gateway (scripted, replayed) keys its answers on. */
export type ChatModelUser =
  | { readonly kind: "agent"; readonly agent: string }
  | { readonly kind: "compaction" }
  | { readonly kind: "judge"; readonly judge: string }
  | { readonly kind: "router"; readonly router: string }
  | { readonly kind: "arbiter"; readonly arbiter: string }
  /** A `@PiiPolicy`'s model detection (`detectWithModel`, #120). */
  | { readonly kind: "pii-policy"; readonly policy: string }
  /** A model reply interpreter (#267 PR 3), with what it reads (a test's `when(…)` matches it). */
  | {
      readonly kind: "reply-interpreter";
      readonly interpreter: string;
      readonly input: ReplyInterpreterInput;
    };

/** A chat model request: its user and complete settings (agents, compaction, judges, LLM routers). */
export interface ChatModelSpec {
  readonly user: ChatModelUser;
  readonly settings: ResolvedModelSettings;
}

/** A router's model, resolved: a decision model by id (`kind: "jev"`), or a chat model with complete settings. */
export type DecisionModel =
  | { readonly kind: "jev"; readonly model: string }
  | { readonly kind: "llm"; readonly settings: ResolvedModelSettings };

/** A decision request: which router asks, on which model, over which routes. */
export interface DecisionSpec {
  readonly router: string;
  readonly model: DecisionModel;
  readonly request: RouteRequest;
}

/** A decision call (`ctx.model.decide`): its cost caller (`judge:<name>`), decision model and request. */
export interface DecideSpec {
  /** The cost caller, also the script key in tests (`judge:<name>`). */
  readonly caller: string;
  readonly model: string;
  readonly request: DecisionRequest;
}

/**
 * The one seam every model call goes through. Agents, judges and compaction get their chat model from
 * `chatModel`; routers and guards routeTo through `routeTo`; judges on a decision model `decide`.
 * Model providers, scripted and replayed models replace the gateway, nothing behind it.
 */
export interface ModelGateway {
  readonly chatModel: (spec: ChatModelSpec) => BaseChatModel;
  readonly routeTo: (spec: DecisionSpec) => Promise<RouteOutcome>;
  /**
   * Answers validated against the questions asked; the cost under the spec's caller. Needed only by
   * judges on a decision model (a gateway without it fails their app at start).
   */
  readonly decide?: (spec: DecideSpec) => Promise<DecisionOutcome>;
}

/** A gateway that also decides (the default, scripted and recording gateways). */
export type DecidingGateway = ModelGateway & Required<Pick<ModelGateway, "decide">>;

/** The raw clients the default gateway calls. */
export interface ModelClients {
  readonly chatModel: ModelFactory;
  readonly jevClient: JevClient;
}

/** Settings that make a different client; identical ones share one. */
const clientKey = (settings: ResolvedModelSettings): string =>
  JSON.stringify([
    settings.model,
    settings.temperature,
    settings.maxTokens,
    settings.reasoning,
    settings.promptCaching,
  ]);

/** The default gateway over raw clients: one chat client per settings, Jev or LLM decisions. */
export function createModelGateway(clients: ModelClients): DecidingGateway {
  const cache = new Map<string, BaseChatModel>();
  const chatModel = ({ settings }: ChatModelSpec): BaseChatModel => {
    const key = clientKey(settings);
    const model = cache.get(key) ?? clients.chatModel(settings);
    cache.set(key, model);
    return model;
  };
  const strategyOf = ({ router, model }: DecisionSpec): RouterEngine =>
    model.kind === "jev"
      ? createJevRouter({ name: router, model: model.model, client: clients.jevClient })
      : createLlmRouter({
          name: router,
          model: chatModel({ user: { kind: "router", router }, settings: model.settings }),
          settings: model.settings,
        });
  const decide = async ({ caller, model, request }: DecideSpec): Promise<DecisionOutcome> => {
    checkDecisionRequest(request);
    const { state, questions } = request;
    const raw = await clients.jevClient({ model, state, questions });
    return readDecision(raw, { caller, model, questions });
  };
  return { chatModel, routeTo: (spec) => strategyOf(spec).route(spec.request), decide };
}

/**
 * Production: every model from the application's model providers (`@Application({ providers })`) —
 * chat models and Jev decisions, each through its provider's connection; keys from `env`.
 */
export function createProviderGateway(
  directory: ModelProviderDirectory,
  options: ProviderClientOptions,
): DecidingGateway {
  return createModelGateway(providerClients(directory, options));
}
