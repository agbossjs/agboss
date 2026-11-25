import { FileView } from "../files/model-files.js";
import { ModelKind } from "./decision-errors.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DEFAULT_MAX_TOKENS } from "../config/types.js";
import { promptCachingOfSetting } from "../models/prompt-caching.js";
import { reasoningOfThinking } from "../models/reasoning.js";
import { DecisionError } from "../core/error-families/config-errors.js";
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
export type RegistryGateway = Pick<ModelGateway, "chatModel" | "decide" | "kindOf">;

/** Chat models of the agents. The router is built separately (see src/routing). */
export interface ModelRegistry {
  readonly agents: ReadonlyMap<string, ModelBinding>;
  /** Each `@Compaction` that writes summaries: its chat model, by compaction name (#120 PR 3). */
  readonly compactions: ReadonlyMap<string, ModelBinding>;
  /** Each `@Judge`'s own model, by judge name. */
  readonly judges: ReadonlyMap<string, JudgeBinding>;
  /**
   * The built-in transcriber's chat model of each agent that reads files as transcriptions (#899),
   * by agent name: the agent's `transcriptionModel`, its `transcriptionMaxTokens`.
   */
  readonly fileTranscribers: ReadonlyMap<string, ModelBinding>;
  /** The built-in image redactor's model of each agent that reads a redacted view (#899). */
  readonly fileRedactors: ReadonlyMap<string, ModelBinding>;
}

/** What a model's settings say of its price and its provider, as they are. */
const ownAccountOf = (
  settings: ModelSettings,
): Pick<ResolvedModelSettings, "price" | "modelProvider" | "unpriced"> => ({
  ...(settings.price === undefined ? {} : { price: settings.price }),
  ...(settings.modelProvider === undefined ? {} : { modelProvider: settings.modelProvider }),
  ...(settings.unpriced === undefined ? {} : { unpriced: settings.unpriced }),
});

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
    ...ownAccountOf(settings),
  };
}

/** A judge on a decision model decides through the gateway, its cost under `judge:<name>`. */
function decisionJudge(
  judge: string,
  model: string,
  gateway: RegistryGateway,
  modelProvider: string | undefined,
): JudgeBinding {
  const decide = gateway.decide;
  if (decide === undefined) {
    throw new DecisionError.InvalidRequest({
      message: `judge "${judge}" is on decision model ${model}, but the app's model gateway has no decide`,
    });
  }
  return {
    kind: ModelKind.Decisions,
    model,
    decide: (request) => decide({ caller: `judge:${judge}`, model, modelProvider, request }),
  };
}

/** The agent's provider reads its files too (#899, #1313): its built-in transcriber's and redactor's models go to it. */
const providerOfAgent = (settings: ModelSettings): Partial<ModelSettings> => ({
  ...(settings.modelProvider === undefined ? {} : { modelProvider: settings.modelProvider }),
  ...(settings.unpriced === undefined ? {} : { unpriced: settings.unpriced }),
});

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
    Object.entries(config.memories ?? {}).flatMap(([compaction, settings]) =>
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
  const fileBindings = (view: FileView, kind: "file-transcriber" | "file-redactor") =>
    new Map(
      Object.entries(config.agents).flatMap(([name, settings]) => {
        const files = settings.files;
        if (files?.views.includes(view) !== true) return [];
        const model = {
          model: view === FileView.Redacted ? files.redactionModel : files.transcriptionModel,
          maxTokens: files.transcriptionMaxTokens,
          ...providerOfAgent(settings),
        };
        return [[name, bindFor({ kind })(model)] as const];
      }),
    );
  const fileTranscribers = fileBindings(FileView.Transcription, "file-transcriber");
  const fileRedactors = fileBindings(FileView.Redacted, "file-redactor");
  return { agents, compactions, judges, fileTranscribers, fileRedactors };
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
  const kind = gateway.kindOf?.(settings.modelProvider) ?? ModelKind.Chat;
  if (kind === ModelKind.Decisions)
    return decisionJudge(judge, settings.model, gateway, settings.modelProvider);
  const resolved = resolveSettings(settings, config.defaults.models);
  const user: ChatModelUser = { kind: "judge", judge };
  return {
    kind: ModelKind.Chat,
    model: settings.model,
    chat: { model: gateway.chatModel({ user, settings: resolved }), settings: resolved },
  };
}

/**
 * A model `@RagReranker`'s chat model through the gateway, with the chat defaults: its script key
 * `reranker:<name>`, its spend billed by the core to the knowledge base (`rag:<name>`).
 */
export const rerankerBindingOf =
  (config: Pick<AgentsConfigOf<string>, "defaults">, gateway: RegistryGateway) =>
  (reranker: string, model: string, modelProvider?: string): ModelBinding => {
    const settings = resolveSettings(
      { model, ...(modelProvider === undefined ? {} : { modelProvider }) },
      config.defaults.models,
    );
    const user: ChatModelUser = { kind: "reranker", reranker };
    return { model: gateway.chatModel({ user, settings }), settings };
  };
