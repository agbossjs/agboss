import type { AgentsConfigOf, ResolvedModelSettings, RouterModel } from "../config/types.js";
import { needsOf, transcriberNeedsOf } from "../files/file-needs.js";
import { judgeReadersOf, type FileReader } from "../files/file-readers.js";
import type { ResolvedModelFiles } from "../files/file-settings.js";
import { FileView } from "../files/model-files.js";
import type { ModelInputKind } from "./content.js";
import { resolveSettings } from "../llm/registry.js";
import { isDecisionModel } from "./decision-models.js";
import { ModelPurpose } from "./resolve.js";

/**
 * Every kind of model use, the first segment of a `ModelUse.key` (#716): the one list a kind of
 * component that calls a model is added to — `ModelUse.key` takes no other prefix, and a test
 * walks it (a startup without the kind's provider key fails at `createApp`).
 */
export const MODEL_USE_KINDS = [
  "agents",
  "compactions",
  "judges",
  "defaults",
  "routers",
  "arbiters",
  "pii",
  "replyInterpreters",
  "guardrails",
  "rerankers",
  "files",
] as const;

export type ModelUseKind = (typeof MODEL_USE_KINDS)[number];

/** A model use's key: its kind, then where it is set — behind its workflow's name in an application of several. */
export type ModelUseKey = `${ModelUseKind}.${string}` | `${string} ${ModelUseKind}.${string}`;

/** One place a model is used, with the settings it is used with. */
export interface ModelUse {
  /** The agents whose files it reads besides its agent's own model (a guardrail's or a judge's model, #899): their types are narrowed to it. */
  readonly forAgents?: readonly string[];
  /** Where it is set: `agents.scout`, `routers.main`, `defaults.router`, `compactions.conversation-compaction`, `guardrails.legal-advice-guardrail`. */
  readonly key: ModelUseKey;
  readonly model: string;
  readonly purpose: ModelPurpose;
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
  /** What it reads of agents' files (#899 §8): a guardrail's. */
  readonly reads?: FileReader | undefined;
}

/** What a model reads of agents' files, as the use says it (#899 §4, §8). */
const fileReadsOf = (reader: FileReader | undefined): Partial<ModelUse> =>
  reader === undefined
    ? {}
    : { needs: reader.needs, isNeedStrict: reader.isNeedStrict, forAgents: reader.agents };

/** A model's use: a decision (decision models) or a chat model with its settings over the defaults. */
const purposeOf = (model: string): ModelPurpose =>
  isDecisionModel(model) ? ModelPurpose.Decision : ModelPurpose.Chat;

const routerUse = (
  key: ModelUse["key"],
  model: RouterModel,
  config: AgentsConfigOf<string>,
): ModelUse =>
  model.kind === "jev"
    ? { key, model: model.model, purpose: ModelPurpose.Decision }
    : {
        key,
        model: model.model,
        purpose: ModelPurpose.Chat,
        settings: resolveSettings(model, config.defaults.models),
      };

/** A reply interpreter (#267 PR 3): its model, or none for a code one. */
export interface ModelNamingInterpreter {
  readonly name: string;
  readonly model: string | undefined;
}

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
  /** Model rerankers of knowledge bases (#703): chat models. */
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
    const use = chat(`files.transcriber.${name}`, {
      model: files.transcriptionModel,
      maxTokens: files.transcriptionMaxTokens,
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
    const use = chat(`files.redactor.${name}`, {
      model: files.redactionModel,
      maxTokens: files.transcriptionMaxTokens,
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
    purpose: ModelPurpose.Chat,
    settings: resolveSettings(settings, config.defaults.models),
  });

/** The judges' models: a decision model or a chat model, each with what it reads of its agents' files (#899 §8). */
function judgeUsesOf(
  config: AgentsConfigOf<string>,
  chat: (key: ModelUseKey, settings: Parameters<typeof resolveSettings>[0]) => ModelUse,
): readonly ModelUse[] {
  const readers = judgeReadersOf(config);
  return Object.entries(config.judges ?? {}).map(([name, judge]): ModelUse => {
    const reads = fileReadsOf(readers.get(name));
    return purposeOf(judge.model) === ModelPurpose.Decision
      ? { key: `judges.${name}`, model: judge.model, purpose: ModelPurpose.Decision, ...reads }
      : { ...chat(`judges.${name}`, judge), ...reads };
  });
}

/**
 * Every model use of a workflow: agents, compactions, judges, the default router, flow routers,
 * model arbiters (#279), the PII policies' model detections (#120, `pii.<policy>`), model reply
 * interpreters (#267, `replyInterpreters.<name>`), the guardrails (#120, `guardrails.<name>`) and the
 * model rerankers (#703, `rerankers.<name>`).
 */
export function modelUsesOf(
  config: AgentsConfigOf<string>,
  routers: readonly ModelNamingRouter[],
  components: ModelNamingComponents = {},
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
    ...Object.entries(config.compactions ?? {}).flatMap(([name, compaction]) =>
      compaction.model === undefined ? [] : [chat(`compactions.${name}`, compaction.model)],
    ),
    ...judgeUsesOf(config, chat),
    ...(config.defaults.router === undefined
      ? []
      : [routerUse("defaults.router", config.defaults.router, config)]),
    ...routers.map((router): ModelUse => ({
      key: `routers.${router.name}`,
      model: router.model,
      purpose: purposeOf(router.model),
    })),
    ...arbiters.map((arbiter): ModelUse => ({
      key: `arbiters.${arbiter.name}`,
      model: arbiter.model,
      purpose: purposeOf(arbiter.model),
    })),
    ...piiDetectors.map((detector) => chat(`pii.${detector.name}`, { model: detector.model })),
    ...interpreters.flatMap(({ name, model }): readonly ModelUse[] => {
      if (model === undefined) return [];
      const key: ModelUseKey = `replyInterpreters.${name}`;
      // a decision model reads an approval's yes / no (#267 S124 a)
      return purposeOf(model) === ModelPurpose.Decision
        ? [{ key, model, purpose: ModelPurpose.Decision }]
        : [chat(key, { model })];
    }),
    ...guardrails.map((guardrail): ModelUse => ({
      key: `guardrails.${guardrail.name}`,
      model: guardrail.model,
      purpose: purposeOf(guardrail.model),
      ...fileReadsOf(guardrail.reads),
    })),
    ...(components.rerankers ?? []).map(({ name, model }) => chat(`rerankers.${name}`, { model })),
  ];
}
