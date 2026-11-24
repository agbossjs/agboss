import type { Class } from "../components/injection.js";
import { deepMerge } from "./deep-merge.js";
import type { FoldedConfig, FoldedWorkflow } from "./fold-config.js";
import type { ModelProviderOverlay, WorkflowOverlay } from "./overlay-types.js";
import { ProfileError, ProfileErrorReason } from "./profile-error.js";
import { AgentsConfigSchema, type AgentsConfigOf } from "./types.js";

/** The workflow key whose overlay applies to every workflow of the application, before its own. */
export const EVERY_WORKFLOW = "*";

/** What a selection's overlays reached while the workflows were assembled: what is left over is a typo. */
export class OverlayUse {
  readonly workflows = new Set<string>();
  /** `<profile>:<name>` of each agent, compaction and prompt a `"*"` overlay changed somewhere. */
  readonly everyReached = new Set<string>();
}

/** What the folded profiles change of one workflow, ready to apply while it is assembled. */
export interface WorkflowPatch {
  readonly modelProvider: Class | undefined;
  /** The providers' overlays: the model names the cascade resolves through. */
  readonly providers: Readonly<Record<string, ModelProviderOverlay>>;
  /** The config with the constants of the profiles applied, validated as a whole. */
  readonly config: (config: AgentsConfigOf<string>) => AgentsConfigOf<string>;
  /** The prompts with the profiles' prompt overrides in place of the declared ones. */
  readonly prompts: (prompts: Readonly<Record<string, string>>) => Record<string, string>;
}

const fail = (reason: ProfileErrorReason, message: string): ProfileError =>
  new ProfileError({ reason, message });

const keysOf = (record: Readonly<Record<string, unknown>> | undefined): string[] =>
  Object.keys(record ?? {});

/** Where an overlay is: its profile, its workflow key, and whether it is the one for every workflow. */
interface Where {
  readonly profile: string;
  readonly key: string;
  readonly isEvery: boolean;
}

const labelOf = (where: Where): string => `profile ${where.profile}: workflows.${where.key}`;

/** The overlay's names that the workflow has; the others are a typo, unless the overlay is for every workflow. */
function known<T>(
  given: Readonly<Record<string, T>> | undefined,
  has: Readonly<Record<string, unknown>> | undefined,
  at: { readonly where: Where; readonly kind: string; readonly use: OverlayUse },
): Record<string, T> | undefined {
  if (given === undefined) return undefined;
  const present = Object.entries(given).filter(([name]) => Object.hasOwn(has ?? {}, name));
  const missing = keysOf(given).filter((name) => !Object.hasOwn(has ?? {}, name));
  const { where } = at;
  if (!where.isEvery && missing.length > 0)
    throw fail(
      ProfileErrorReason.Unknown,
      `${labelOf(where)}: unknown ${at.kind}: ${missing.join(", ")}`,
    );
  for (const [name] of present) at.use.everyReached.add(`${where.profile}:${at.kind}:${name}`);
  return Object.fromEntries(present);
}

/** One workflow overlay's constants as a config patch: only names the workflow has. */
function constantsOf(
  overlay: WorkflowOverlay,
  config: AgentsConfigOf<string>,
  at: { readonly where: Where; readonly use: OverlayUse },
): Record<string, unknown> {
  const agents = known(overlay.agents, config.agents, { ...at, kind: "agents" });
  const compactions = known(overlay.compactions, config.compactions, {
    ...at,
    kind: "compactions",
  });
  return {
    ...(overlay.version === undefined ? {} : { version: overlay.version }),
    ...(overlay.defaults === undefined ? {} : { defaults: overlay.defaults }),
    ...(agents === undefined ? {} : { agents }),
    ...(compactions === undefined ? {} : { compactions }),
  };
}

/** The overlays that apply to a workflow, in the order they apply: per profile, `"*"` then its own. */
function overlaysOf(folded: FoldedConfig, workflow: string): readonly (Where & FoldedWorkflow)[] {
  return folded.layers.flatMap((layer) =>
    [EVERY_WORKFLOW, workflow].flatMap((key) => {
      const one = layer.workflows[key];
      return one === undefined || (key === workflow && workflow === EVERY_WORKFLOW)
        ? []
        : [{ ...one, profile: layer.name, key, isEvery: key === EVERY_WORKFLOW }];
    }),
  );
}

/** The workflow's config under the app-wide defaults, then each profile's `"*"` and own overlay. */
function configOf(
  config: AgentsConfigOf<string>,
  folded: FoldedConfig,
  use: OverlayUse,
): AgentsConfigOf<string> {
  let merged: unknown = config;
  if (folded.defaults !== undefined) merged = deepMerge(merged, { defaults: folded.defaults });
  for (const overlay of overlaysOf(folded, config.name))
    merged = deepMerge(merged, constantsOf(overlay.overlay, config, { where: overlay, use }));
  const parsed = AgentsConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw fail(
      ProfileErrorReason.Invalid,
      `profile ${folded.profiles.join(",")}: workflow "${config.name}": ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`,
    );
  }
  return merged as AgentsConfigOf<string>; // validated above; keeps the config's literal shape
}

/** The prompt overrides of each profile's `"*"` (agents the workflow has) and own overlay (all must be its agents). */
function promptsOf(
  prompts: Readonly<Record<string, string>>,
  folded: FoldedConfig,
  workflow: string,
  use: OverlayUse,
): Record<string, string> {
  let result: Record<string, string> = { ...prompts };
  for (const overlay of overlaysOf(folded, workflow)) {
    const missing = keysOf(overlay.prompts).filter((agent) => !Object.hasOwn(prompts, agent));
    if (!overlay.isEvery && missing.length > 0)
      throw fail(
        ProfileErrorReason.Unknown,
        `${labelOf(overlay)}: unknown prompts: ${missing.join(", ")}`,
      );
    for (const agent of keysOf(overlay.prompts))
      if (!missing.includes(agent)) use.everyReached.add(`${overlay.profile}:prompts:${agent}`);
    result = {
      ...result,
      ...Object.fromEntries(
        Object.entries(overlay.prompts).filter(([agent]) => !missing.includes(agent)),
      ),
    };
  }
  return result;
}

/** The patch of one workflow; the use is recorded so a left-over key can be named afterwards. */
export function workflowPatchOf(
  folded: FoldedConfig,
  workflow: string,
  use: OverlayUse,
): WorkflowPatch {
  use.workflows.add(workflow);
  const providers = folded.layers
    .flatMap((layer) => [layer.workflows[EVERY_WORKFLOW], layer.workflows[workflow]])
    .flatMap((one) => (one?.modelProvider === undefined ? [] : [one.modelProvider]));
  return {
    modelProvider: providers.at(-1),
    providers: folded.modelProviders,
    config: (config) => configOf(config, folded, use),
    prompts: (prompts) => promptsOf(prompts, folded, workflow, use),
  };
}

/** What the profiles name that no workflow has, or that no workflow `"*"` reached: a typo, found after assembly. */
export function checkOverlayUse(folded: FoldedConfig, use: OverlayUse): void {
  const profiles = folded.profiles.join(",");
  for (const layer of folded.layers) {
    const absent = keysOf(layer.workflows).filter(
      (name) => name !== EVERY_WORKFLOW && !use.workflows.has(name),
    );
    if (absent.length > 0)
      throw fail(
        ProfileErrorReason.Unknown,
        `profile ${layer.name}: workflows: no such workflow in the application: ${absent.join(", ")} — it has: ${[...use.workflows].join(", ")}`,
      );
    const every = layer.workflows[EVERY_WORKFLOW];
    const lost = [
      ...keysOf(every?.overlay.agents).map((name) => `agents:${name}`),
      ...keysOf(every?.overlay.compactions).map((name) => `compactions:${name}`),
      ...keysOf(every?.prompts).map((name) => `prompts:${name}`),
    ].filter((key) => !use.everyReached.has(`${layer.name}:${key}`));
    if (lost.length > 0)
      throw fail(
        ProfileErrorReason.Unknown,
        `profile ${layer.name}: workflows.${EVERY_WORKFLOW}: no workflow has: ${lost.map((key) => key.replace(":", " ")).join(", ")} (of ${profiles})`,
      );
  }
}
