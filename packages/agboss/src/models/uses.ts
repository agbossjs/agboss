import type { AgentsConfigOf, ResolvedModelSettings, RouterModel } from "../config/types.js";
import { resolveSettings } from "../llm/registry.js";
import { isDecisionModel } from "./decision-models.js";
import { ModelPurpose } from "./resolve.js";

/** One place a model is used, with the settings it is used with. */
export interface ModelUse {
  /** Where it is set: `agents.scout`, `routers.main`, `defaults.router`, `compaction`, `guards.input.pii`. */
  readonly key: string;
  readonly model: string;
  readonly purpose: ModelPurpose;
  /** Chat uses: the settings over the chat defaults (reasoning and caching unset = the provider's). */
  readonly settings?: ResolvedModelSettings;
}

/** A router that names its model (`@Router({ model })`) — or a model arbiter (`@Arbiter({ model })`, #279). */
export interface ModelNamingRouter {
  readonly name: string;
  readonly model: string;
}

/** A model's use: a decision (decision models) or a chat model with its settings over the defaults. */
const purposeOf = (model: string): ModelPurpose =>
  isDecisionModel(model) ? ModelPurpose.Decision : ModelPurpose.Chat;

const routerUse = (key: string, model: RouterModel, config: AgentsConfigOf<string>): ModelUse =>
  model.kind === "jev"
    ? { key, model: model.model, purpose: ModelPurpose.Decision }
    : {
        key,
        model: model.model,
        purpose: ModelPurpose.Chat,
        settings: resolveSettings(model, config.defaults.models),
      };

const guardUses = (config: AgentsConfigOf<string>): ModelUse[] =>
  (["input", "output"] as const).flatMap((side) =>
    Object.entries(config.guards?.[side] ?? {}).flatMap(([name, guard]) =>
      guard.model === undefined ? [] : [routerUse(`guards.${side}.${name}`, guard.model, config)],
    ),
  );

/** A reply interpreter (#267 PR 3): its model, or none for a code one. */
export interface ModelNamingInterpreter {
  readonly name: string;
  readonly model: string | undefined;
}

/** The components besides routers that name their own model. */
export interface ModelNamingComponents {
  /** Model arbiters (#279). */
  readonly arbiters: readonly ModelNamingRouter[];
  /** The PII policies' model detections (#120). */
  readonly piiDetectors: readonly ModelNamingRouter[];
  /** Reply interpreters (#267 PR 3): a model one's chat model. */
  readonly interpreters: readonly ModelNamingInterpreter[];
}

const NO_COMPONENTS: ModelNamingComponents = { arbiters: [], piiDetectors: [], interpreters: [] };

/**
 * Every model use of a workflow: agents, compaction, judges, the default router, guards, flow routers,
 * model arbiters (#279), the PII policies' model detections (#120, `pii.<policy>`) and model reply
 * interpreters (#267, `replyInterpreters.<name>`).
 */
export function modelUsesOf(
  config: AgentsConfigOf<string>,
  routers: readonly ModelNamingRouter[],
  components: ModelNamingComponents = NO_COMPONENTS,
): readonly ModelUse[] {
  const { arbiters, piiDetectors, interpreters } = components;
  const chat = (key: string, settings: Parameters<typeof resolveSettings>[0]): ModelUse => ({
    key,
    model: settings.model,
    purpose: ModelPurpose.Chat,
    settings: resolveSettings(settings, config.defaults.models),
  });
  return [
    ...Object.entries(config.agents).map(([name, agent]) => chat(`agents.${name}`, agent)),
    ...(config.compaction === undefined ? [] : [chat("compaction", config.compaction.model)]),
    ...Object.entries(config.judges ?? {}).map(([name, judge]) =>
      purposeOf(judge.model) === ModelPurpose.Decision
        ? { key: `judges.${name}`, model: judge.model, purpose: ModelPurpose.Decision }
        : chat(`judges.${name}`, judge),
    ),
    ...(config.defaults.router === undefined
      ? []
      : [routerUse("defaults.router", config.defaults.router, config)]),
    ...guardUses(config),
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
    ...interpreters.flatMap(({ name, model }) =>
      model === undefined ? [] : [chat(`replyInterpreters.${name}`, { model })],
    ),
  ];
}
