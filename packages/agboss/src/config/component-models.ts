import type { Class } from "../components/injection.js";
import type { ComponentModelOverrides } from "../models/model-cascade.js";
import type { FoldedConfig, FoldedWorkflow } from "./fold-config.js";
import { ProfileError, ProfileErrorReason } from "./profile-error.js";

/** One workflow's component overrides, and what its own profile overlays named of its routers. */
export interface WorkflowModels {
  readonly overrides: ComponentModelOverrides;
  /** `<profile>` and the router names the profile's own overlay of this workflow names (a typo if the workflow lacks one). */
  readonly own: readonly { readonly profile: string; readonly routers: readonly string[] }[];
}

/** One overlay that applies to a workflow, with where it comes from. */
export type AppliedOverlay = FoldedWorkflow & {
  readonly profile: string;
  readonly isEvery: boolean;
};

const keysOf = (record: Readonly<Record<string, unknown>> | undefined): string[] =>
  Object.keys(record ?? {});

const fail = (reason: ProfileErrorReason, message: string): ProfileError =>
  new ProfileError({ reason, message });

/**
 * The models profiles change of one workflow's components: the application-wide shelves (`judges`,
 * `arbiters`, …), then each profile's routers — its `"*"` first, then the workflow's own.
 */
export function modelsOf(
  folded: FoldedConfig,
  workflow: string,
  use: { readonly models: Map<string, WorkflowModels> },
  overlays: readonly AppliedOverlay[],
  providers: readonly Class[],
): ComponentModelOverrides {
  const byKey = new Map(Object.entries(folded.componentModels));
  const own: { profile: string; routers: string[] }[] = [];
  for (const where of overlays) {
    for (const [name, one] of Object.entries(where.routers))
      byKey.set(`routers.${name}`, { ...byKey.get(`routers.${name}`), ...one });
    if (!where.isEvery) own.push({ profile: where.profile, routers: keysOf(where.routers) });
  }
  const overrides: ComponentModelOverrides = { providers, byKey, reached: new Set() };
  use.models.set(workflow, { overrides, own });
  return overrides;
}

/** The kind of component a use key's prefix names, for the sentence of a typo. */
const SHELF_OF_PREFIX: Readonly<Record<string, string>> = {
  judges: "judges",
  arbiters: "arbiters",
  guardrails: "guardrails",
  pii: "piiPolicies",
  channelInterpreters: "channelInterpreters",
  ragRerankers: "ragRerankers",
  fileTranscribers: "fileTranscribers",
  fileMaskers: "fileMaskers",
};

/** The overridden components no workflow has: a name in a shelf, a router a workflow's own overlay names. */
export function checkComponentModels(
  folded: FoldedConfig,
  use: { readonly models: ReadonlyMap<string, WorkflowModels> },
): void {
  const profiles = folded.profiles.join(",");
  const reached = new Set([...use.models.values()].flatMap((one) => [...one.overrides.reached]));
  const lost = Object.keys(folded.componentModels).filter((key) => !reached.has(key));
  const [first] = lost;
  if (first !== undefined) {
    const prefix = Object.keys(SHELF_OF_PREFIX).find((one) => first.startsWith(`${one}.`)) ?? "";
    const name = first.slice(prefix.length + 1);
    throw fail(
      ProfileErrorReason.Unknown,
      `profile ${profiles}: ${SHELF_OF_PREFIX[prefix] ?? prefix}.${name}: no such component with a model in the application`,
    );
  }
  for (const [workflow, one] of use.models) {
    for (const { profile, routers } of one.own) {
      const missing = routers.filter((name) => !one.overrides.reached.has(`routers.${name}`));
      if (missing.length > 0)
        throw fail(
          ProfileErrorReason.Unknown,
          `profile ${profile}: workflows.${workflow}: unknown routers: ${missing.join(", ")}`,
        );
    }
  }
}
