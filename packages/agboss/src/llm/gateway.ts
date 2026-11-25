import { servedDecisionOf } from "./decisions-failover.js";
import { billedDecisionRecord, withDecisionSpend } from "../finops/failed-decision.js";
import { pricedDecisionRecord } from "../finops/decision-price.js";
import type { UsageRecord } from "../finops/usage.js";
import type { ModelPricing } from "../models/model-pricing.js";
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
import {
  providerClients,
  type ChatExtensions,
  type ProviderClientOptions,
} from "./provider-clients.js";
import type { ModelProviderDirectory } from "../models/resolve.js";
import type { ModelKind } from "../models/model-kind.js";
import type { ReplyInterpreterInput } from "../channels/reply-reader.js";

/** Who a chat model is for: what a substitute gateway (scripted, replayed) keys its answers on. */
export type ChatModelUser =
  | { readonly kind: "agent"; readonly agent: string }
  /** A `@Compaction`'s summaries (#120 PR 3). */
  | { readonly kind: "compaction"; readonly compaction: string }
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
    }
  /** A guardrail's check on a chat model (#120). */
  | { readonly kind: "guardrail"; readonly guardrail: string }
  /** A model `@Reranker` (#703). */
  | { readonly kind: "reranker"; readonly reranker: string }
  /** The built-in transcriber of files (#899): its cost caller and script key `files:transcriber`. */
  | { readonly kind: "file-transcriber" }
  /** The built-in image redactor (#899): its cost caller and script key `files:redactor`. */
  | { readonly kind: "file-redactor" };

/** A chat model request: its user and complete settings (agents, compaction, judges, LLM routers). */
export interface ChatModelSpec {
  readonly user: ChatModelUser;
  readonly settings: ResolvedModelSettings;
}

/** A router's model, resolved: a decision model by id (`kind: "jev"`), or a chat model with complete settings. */
export type DecisionModel =
  | { readonly kind: "jev"; readonly model: string; readonly modelProvider?: string | undefined }
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
  /** The provider's `name` its cascade resolved (#1313). */
  readonly modelProvider?: string | undefined;
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
  /**
   * What the provider a model's cascade resolved speaks (#1313): chat or decisions; `undefined`
   * for no provider named — the model's name decides, as it did before drivers.
   */
  readonly kindOf?: (modelProvider: string | undefined) => ModelKind | undefined;
}

/** A gateway that also decides (the default, scripted and recording gateways). */
export type DecidingGateway = ModelGateway & Required<Pick<ModelGateway, "decide">>;

/** The raw clients the default gateway calls. */
export interface ModelClients {
  readonly chatModel: ModelFactory;
  readonly jevClient: JevClient;
  readonly kindOf?: ModelGateway["kindOf"];
  /** Prices a decision its provider reported no cost for, by that provider's table (bughunt 2026-11-25 #2). */
  readonly pricing?: ModelPricing;
}

/** Settings that make a different client; identical ones share one. */
const clientKey = (settings: ResolvedModelSettings): string =>
  JSON.stringify([
    settings.model,
    settings.temperature,
    settings.maxTokens,
    settings.reasoning,
    settings.promptCaching,
    settings.modelProvider,
  ]);

/** One decision through the clients: validated, recorded under who answered, priced by its table (bughunt #2). */
async function decisionOf(
  clients: ModelClients,
  { caller, model, modelProvider, request }: DecideSpec,
): Promise<DecisionOutcome> {
  checkDecisionRequest(request);
  const { state, questions } = request;
  const raw = await clients.jevClient({ model, state, questions }, modelProvider);
  // a fallback that answered is who the call is recorded under, as its own model (#1313d)
  const by = servedDecisionOf(raw);
  const answered = { model: by?.model ?? model, provider: by?.provider ?? modelProvider };
  const priced = (record: UsageRecord): UsageRecord =>
    pricedDecisionRecord(record, raw, answered.model, clients.pricing);
  try {
    const outcome = readDecision(raw, { caller, ...answered, questions });
    return { ...outcome, usage: priced(outcome.usage) };
  } catch (error) {
    // the provider answered and billed it: the spend travels with the failure, once (#1399)
    const call = { caller, ...answered };
    throw withDecisionSpend(error, priced(billedDecisionRecord(call, { state, questions }, raw)));
  }
}

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
      ? createJevRouter({
          name: router,
          model: model.model,
          client: (request) => clients.jevClient(request, model.modelProvider),
          provider: model.modelProvider,
          servedBy: servedDecisionOf,
          ...(clients.pricing === undefined ? {} : { pricing: clients.pricing }),
        })
      : createLlmRouter({
          name: router,
          model: chatModel({ user: { kind: "router", router }, settings: model.settings }),
          settings: model.settings,
        });
  const decide = (spec: DecideSpec): Promise<DecisionOutcome> => decisionOf(clients, spec);
  return {
    chatModel,
    routeTo: (spec) => strategyOf(spec).route(spec.request),
    decide,
    ...(clients.kindOf === undefined ? {} : { kindOf: clients.kindOf }),
  };
}

/**
 * Production: every model from the application's model providers (`@Application({ providers })`) —
 * chat models and Jev decisions, each through its provider's connection; keys from `env`. A
 * transport provider (listed, or a breaker's fallback) needs `extensions` (`chatExtensionsFor`, #385).
 */
export function createProviderGateway(
  directory: ModelProviderDirectory,
  options: ProviderClientOptions,
  extensions?: ChatExtensions,
): DecidingGateway {
  return createModelGateway(providerClients(directory, options, extensions));
}
