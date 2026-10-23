import { ModelKind } from "./decision-errors.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DEFAULT_MAX_TOKENS } from "../config/types.js";
import { promptCachingOfSetting } from "../models/prompt-caching.js";
import { reasoningOfThinking } from "../models/reasoning.js";
import { isDecisionModel } from "../models/decision-models.js";
import { DecisionError } from "./decision-errors.js";
import type { DecisionOutcome } from "./decision-response.js";
import type { DecisionRequest } from "./decisions.js";
import type { ChatModelUser, ModelGateway } from "./gateway.js";
import type {
  AgentsConfigOf,
  ChatDefaults,
  ModelSettings,
  ResolvedModelSettings,
} from "../config/types.js";

/** A model together with the settings (and price) it was created from. */
export interface ModelBinding {
  readonly model: BaseChatModel;
  readonly settings: ResolvedModelSettings;
}

export type ModelFactory = (settings: ResolvedModelSettings) => BaseChatModel;

/** A judge's model: a chat model (`invoke`), or a decision model (`decide`) through the gateway. */
export type JudgeBinding =
  | { readonly kind: ModelKind.Chat; readonly model: string; readonly chat: ModelBinding }
  | {
      readonly kind: ModelKind.Decisions;
      readonly model: string;
      readonly decide: (request: DecisionRequest) => Promise<DecisionOutcome>;
    };

/** What the registry needs of the gateway; `decide` only when a judge is on a decision model. */
export type RegistryGateway = Pick<ModelGateway, "chatModel" | "decide">;

/** Chat models of the agents. The router is built separately (see src/routing). */
export interface ModelRegistry {
  readonly agents: ReadonlyMap<string, ModelBinding>;
  /** Each `@Compaction` that writes summaries: its chat model, by compaction name (#120 PR 3). */
  readonly compactions: ReadonlyMap<string, ModelBinding>;
  /** Each `@Judge`'s own model, by judge name. */
  readonly judges: ReadonlyMap<string, JudgeBinding>;
}

/**
 * An agent's (or LLM router's) model settings over the chat defaults. Reasoning and caching set
 * nowhere stay unset: the model provider's own apply.
 */
export function resolveSettings(
  settings: ModelSettings,
  defaults: ChatDefaults,
): ResolvedModelSettings {
  const thinking = settings.thinking ?? defaults.thinking;
  const promptCaching = promptCachingOfSetting(settings.cache ?? defaults.cache);
  return {
    model: settings.model,
    temperature: settings.temperature ?? defaults.temperature,
    maxTokens: settings.maxTokens ?? defaults.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(thinking === undefined ? {} : { reasoning: reasoningOfThinking(thinking) }),
    ...(promptCaching === undefined ? {} : { promptCaching }),
    ...(settings.price === undefined ? {} : { price: settings.price }),
  };
}

/** A judge on a decision model decides through the gateway, its cost under `judge:<name>`. */
function decisionJudge(judge: string, model: string, gateway: RegistryGateway): JudgeBinding {
  const decide = gateway.decide;
  if (decide === undefined) {
    throw new DecisionError(
      `judge "${judge}" is on decision model ${model}, but the app's model gateway has no decide`,
    );
  }
  return {
    kind: ModelKind.Decisions,
    model,
    decide: (request) => decide({ caller: `judge:${judge}`, model, request }),
  };
}

/** Builds one binding per agent and judge; each model comes from the gateway (which shares identical ones). */
export function createModelRegistry(
  config: AgentsConfigOf<string>,
  gateway: RegistryGateway,
): ModelRegistry {
  const bindFor =
    (user: ChatModelUser) =>
    (settings: ModelSettings): ModelBinding => {
      const resolved = resolveSettings(settings, config.defaults.models);
      return { model: gateway.chatModel({ user, settings: resolved }), settings: resolved };
    };
  const agents = new Map(
    Object.entries(config.agents).map(
      ([name, settings]) => [name, bindFor({ kind: "agent", agent: name })(settings)] as const,
    ),
  );
  const compactions = new Map(
    Object.entries(config.compactions ?? {}).flatMap(([compaction, settings]) =>
      settings.model === undefined
        ? []
        : [[compaction, bindFor({ kind: "compaction", compaction })(settings.model)] as const],
    ),
  );
  const judges = new Map(
    Object.entries(config.judges ?? {}).map(([judge, settings]): [string, JudgeBinding] => [
      judge,
      judgeBindingOf(judge, settings, config, gateway),
    ]),
  );
  return { agents, compactions, judges };
}

/**
 * One judge's model through the gateway (an agent's judge at start; an eval suite's judge when its
 * run needs it, #396): a decision model decides, a chat model is bound with the chat defaults.
 */
export function judgeBindingOf(
  judge: string,
  settings: ModelSettings,
  config: Pick<AgentsConfigOf<string>, "defaults">,
  gateway: RegistryGateway,
): JudgeBinding {
  if (isDecisionModel(settings.model)) return decisionJudge(judge, settings.model, gateway);
  const resolved = resolveSettings(settings, config.defaults.models);
  const user: ChatModelUser = { kind: "judge", judge };
  return {
    kind: ModelKind.Chat,
    model: settings.model,
    chat: { model: gateway.chatModel({ user, settings: resolved }), settings: resolved },
  };
}
