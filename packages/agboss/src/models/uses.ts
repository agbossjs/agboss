import type { AgentsConfigOf, ResolvedModelSettings, RouterModel } from "../config/types.js";
import { needsOf, transcriberNeedsOf } from "../files/file-needs.js";
import { judgeReadersOf, type FileReader } from "../files/file-readers.js";
import type { ResolvedModelFiles } from "../files/file-settings.js";
import { FileView } from "../files/model-files.js";
import type { ModelInputKind } from "./content.js";
import { resolveSettings } from "../llm/registry.js";
import { ModelKind } from "./model-kind.js";
import { providerOf, purposeOf, type ProviderKinds } from "./use-purpose.js";
import { interpreterUsesOf, type ModelNamingInterpreter } from "./interpreter-uses.js";

/**
 * Every kind of model use, the first segment of a `ModelUse.key` (#716): the one list a kind of
 * component that calls a model is added to — `ModelUse.key` takes no other prefix, and a test
 * walks it (a startup without the kind's provider key fails at `createApp`).
 */
export const MODEL_USE_KINDS = [
  "agents",
  "memories",
  "judges",
  "defaults",
  "routers",
  "arbiters",
  "pii",
  "channelInterpreters",
  "guardrails",
  "ragRerankers",
  "fileMaskers",
  "fileTranscribers",
] as const;

export type ModelUseKind = (typeof MODEL_USE_KINDS)[number];

/** A model use's key: its kind, then where it is set — behind its workflow's name in an application of several. */
export type ModelUseKey = `${ModelUseKind}.${string}` | `${string} ${ModelUseKind}.${string}`;

/** One place a model is used, with the settings it is used with. */
export interface ModelUse {
  /** The agents whose files it reads besides its agent's own model (a guardrail's or a judge's model, #899): their types are narrowed to it. */
  readonly forAgents?: readonly string[];
  /** Where it is set: `agents.scout`, `routers.main`, `defaults.router`, `memories.conversation-memory`, `guardrails.legal-advice-guardrail`. */
  readonly key: ModelUseKey;
  readonly model: string;
  readonly purpose: ModelKind;
  /** The provider's `name` its cascade resolved (#1313); absent = the older providers' `serves` decide. */
  readonly modelProvider?: string | undefined;
  /** Chat uses: the settings over the chat defaults (reasoning and caching unset = the provider's). */
  readonly settings?: ResolvedModelSettings;
  /**
   * What the use reads besides text (#899 §4): each kind with a media type and the view it comes
   * in. A model that reports its `inputs` must take every kind of a strict use; a defaulted one
   * (`isNeedStrict: false`) is narrowed to the kinds the model takes at start.
   */
  readonly needs?: readonly InputNeed[];
  readonly isNeedStrict?: boolean;
}

/** One kind of input a model use reads. */
export interface InputNeed {
  readonly kind: ModelInputKind;
  readonly mediaType: string;
  readonly view: string;
}

/** A router that names its model (`@Router({ model })`) — or a model arbiter (`@Arbiter({ model })`, #279). */
export interface ModelNamingRouter {
  readonly name: string;
  readonly model: string;
  /** The provider's `name` the component names itself (#1313). */
  readonly modelProvider?: string | undefined;
  /** What it reads of agents' files (#899 §8): a guardrail's. */
  readonly reads?: FileReader | undefined;
}

/** What a model reads of agents' files, as the use says it (#899 §4, §8). */
const fileReadsOf = (reader: FileReader | undefined): Partial<ModelUse> =>
  reader === undefined
    ? {}
    : { needs: reader.needs, isNeedStrict: reader.isNeedStrict, forAgents: reader.agents };

const routerUse = (
  key: ModelUse["key"],
  model: RouterModel,
  config: AgentsConfigOf<string>,
  kinds?: ProviderKinds,
): ModelUse => {
  const isDecisions =
    model.kind === "jev" ||
    (model.modelProvider !== undefined &&
      purposeOf(model.modelProvider, kinds) === ModelKind.Decisions);
  const purpose = isDecisions ? ModelKind.Decisions : ModelKind.Chat;
  const settings = isDecisions ? {} : { settings: resolveSettings(model, config.defaults.models) };
  return { key, model: model.model, purpose, ...providerOf(model.modelProvider), ...settings };
};

/** The components besides routers that name their own model. */
export interface ModelNamingComponents {
  /** Model arbiters (#279). */
  readonly arbiters?: readonly ModelNamingRouter[];
  /** The PII policies' model detections (#120). */
  readonly piiDetectors?: readonly ModelNamingRouter[] | undefined;
  /** Reply interpreters (#267): a model one's chat or decision model. */
  readonly interpreters?: readonly ModelNamingInterpreter[] | undefined;
  /** Guardrails (#120 PR 2). */
  readonly guardrails?: readonly ModelNamingRouter[] | undefined;
  /** Model rerankers of knowledge bases: chat models. */
  readonly rerankers?: readonly ModelNamingRouter[] | undefined;
  /**
   * Whether the built-in transcriber is the one in use (#899): its model is a use only then — an
   * application with its own `FileTranscriber` never needs `DEFAULT_FILE_MODEL`. Default: yes.
   */
  readonly builtInFileModels?: boolean | undefined;
  /** Whether the built-in image redactor is the one in use: its model is a use only then (#899). Default: yes. */
  readonly builtInFileRedactor?: boolean | undefined;
}

/** The inputs an agent's files need of its model: strict when the developer named the types. */
const fileNeedsOf = (files: ResolvedModelFiles | undefined): Partial<ModelUse> =>
  files === undefined ? {} : { needs: needsOf(files), isNeedStrict: files.isTypesExplicit };

/** The built-in transcriber's model of each agent that reads transcriptions: a use of its own (#899 §6). */
function fileModelUsesOf(
  config: AgentsConfigOf<string>,
  isBuiltIn: boolean,
  chat: (key: ModelUseKey, settings: Parameters<typeof resolveSettings>[0]) => ModelUse,
): readonly ModelUse[] {
  if (!isBuiltIn) return [];
  return Object.entries(config.agents).flatMap(([name, agent]) => {
    const files = agent.files;
    if (files?.views.includes(FileView.Transcription) !== true) return [];
    const use = chat(`fileTranscribers.${name}`, {
      model: files.transcriptionModel,
      maxTokens: files.transcriptionMaxTokens,
      // the agent's provider reads its files too (#899, #1313)
      ...(agent.modelProvider === undefined ? {} : { modelProvider: agent.modelProvider }),
    });
    return [{ ...use, needs: transcriberNeedsOf(files), isNeedStrict: true }];
  });
}

/** The built-in redactor's model of each agent that reads a redacted view: it reads the image itself (#899 §6). */
function redactorUsesOf(
  config: AgentsConfigOf<string>,
  isBuiltIn: boolean,
  chat: (key: ModelUseKey, settings: Parameters<typeof resolveSettings>[0]) => ModelUse,
): readonly ModelUse[] {
  if (!isBuiltIn) return [];
  return Object.entries(config.agents).flatMap(([name, agent]) => {
    const files = agent.files;
    if (files?.views.includes(FileView.Redacted) !== true) return [];
    const use = chat(`fileMaskers.${name}`, {
      model: files.redactionModel,
      maxTokens: files.transcriptionMaxTokens,
      ...(agent.modelProvider === undefined ? {} : { modelProvider: agent.modelProvider }),
    });
    return [
      {
        ...use,
        needs: [{ kind: "image", mediaType: "image/png", view: FileView.Redacted }],
        isNeedStrict: true,
      },
    ];
  });
}

/** A chat model's use at `key`, its settings over the workflow's chat defaults. */
const chatUseOf =
  (config: AgentsConfigOf<string>) =>
  (key: ModelUse["key"], settings: Parameters<typeof resolveSettings>[0]): ModelUse => ({
    key,
    model: settings.model,
    purpose: ModelKind.Chat,
    ...providerOf(settings.modelProvider),
    settings: resolveSettings(settings, config.defaults.models),
  });

/** The judges' models: a decision model or a chat model, each with what it reads of its agents' files (#899 §8). */
function judgeUsesOf(
  config: AgentsConfigOf<string>,
  chat: (key: ModelUseKey, settings: Parameters<typeof resolveSettings>[0]) => ModelUse,
  kinds?: ProviderKinds,
): readonly ModelUse[] {
  const readers = judgeReadersOf(config);
  return Object.entries(config.judges ?? {}).map(([name, judge]): ModelUse => {
    const reads = fileReadsOf(readers.get(name));
    return purposeOf(judge.modelProvider, kinds) === ModelKind.Decisions
      ? {
          key: `judges.${name}`,
          model: judge.model,
          purpose: ModelKind.Decisions,
          ...providerOf(judge.modelProvider),
          ...reads,
        }
      : { ...chat(`judges.${name}`, judge), ...reads };
  });
}

/** A component that names its model (and maybe its provider): a model router's or an arbiter's use. */
const namedUse =
  (kind: "routers" | "arbiters" | "ragRerankers", kinds: ProviderKinds | undefined) =>
  (named: ModelNamingRouter): ModelUse => ({
    key: `${kind}.${named.name}`,
    model: named.model,
    purpose: purposeOf(named.modelProvider, kinds),
    ...providerOf(named.modelProvider),
  });

/**
 * Every model use of a workflow: agents, compactions, judges, the default router, flow routers,
 * model arbiters (#279), the PII policies' model detections (#120, `pii.<policy>`), model reply
 * interpreters (#267, `channelInterpreters.<name>`), the guardrails (#120, `guardrails.<name>`) and the
 * model rerankers (#703, `ragRerankers.<name>`).
 */
export function modelUsesOf(
  config: AgentsConfigOf<string>,
  routers: readonly ModelNamingRouter[],
  components: ModelNamingComponents = {},
  kinds?: ProviderKinds,
): readonly ModelUse[] {
  const { arbiters = [], piiDetectors = [], interpreters = [], guardrails = [] } = components;
  const chat = chatUseOf(config);
  return [
    ...Object.entries(config.agents).map(([name, agent]) => ({
      ...chat(`agents.${name}`, agent),
      ...fileNeedsOf(agent.files),
    })),
    ...fileModelUsesOf(config, components.builtInFileModels !== false, chat),
    ...redactorUsesOf(config, components.builtInFileRedactor !== false, chat),
    ...Object.entries(config.memories ?? {}).flatMap(([name, compaction]) =>
      compaction.model === undefined ? [] : [chat(`memories.${name}`, compaction.model)],
    ),
    ...judgeUsesOf(config, chat, kinds),
    ...(config.defaults.router === undefined
      ? []
      : [routerUse("defaults.router", config.defaults.router, config, kinds)]),
    ...routers.map(namedUse("routers", kinds)),
    ...arbiters.map(namedUse("arbiters", kinds)),
    ...piiDetectors.map((detector) =>
      chat(`pii.${detector.name}`, {
        model: detector.model,
        ...providerOf(detector.modelProvider),
      }),
    ),
    ...interpreterUsesOf(interpreters, chat, kinds),
    ...guardrails.map((guardrail): ModelUse => ({
      key: `guardrails.${guardrail.name}`,
      model: guardrail.model,
      purpose: purposeOf(guardrail.modelProvider, kinds),
      ...providerOf(guardrail.modelProvider),
      ...fileReadsOf(guardrail.reads),
    })),
    ...(components.rerankers ?? []).map(namedUse("ragRerankers", kinds)),
  ];
}
