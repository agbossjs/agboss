import { foldedConfigFor } from "../config/load-config.js";
import type { FoldedConfig } from "../config/fold-config.js";
import { ProfileError, ProfileErrorReason } from "../config/profile-error.js";
import { APP_DEFAULT_PROFILE } from "../config/profile-names.js";
import {
  checkOverlayUse,
  OverlayUse,
  workflowPatchOf,
  type WorkflowPatch,
} from "../config/workflow-overlay.js";
import { workflowDeclarationOf } from "../components/module.js";
import type { BudgetOverlays } from "../budgets/budget-overlay.js";
import type { Class } from "../components/injection.js";
import type { EnvOverrides } from "../environments/define-env.js";
import type { EnvContract } from "../environments/env-ref.js";
import {
  isDriverOptions,
  isModelProviderClass,
  modelProviderOf,
} from "../models/model-provider.decorator.js";
import type { ModelProviderType } from "../models/model-provider.decorator.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { ApplicationAssembly, AssemblyReplacements } from "./assembly-options.js";
import {
  declaredOptionsOf,
  type ApplicationDeclaration,
  type ApplicationOptions,
} from "./application.js";
import type { PauseTargetOverrides } from "../channels/pause-targets.js";
import { pauseOverridesOf } from "../config/pause-overrides.js";
import { checkComponentShelves, componentOptionsOf } from "./component-profile.js";
import { budgetOverlaysOf } from "./budget-profile.js";
import { checkMcpServers } from "./option-checks.js";
import { optionCarrierOf, placementOverridesOf } from "./option-shelves.js";
import type { ComponentOptions } from "../components/component-options.js";
import { checkMemories, checkPauseTargets } from "./profile-checks.js";
import { withIsolatedStorage } from "./isolated-storage.js";

/**
 * The application's options as the selected profiles leave them: the classes a profile replaces
 * (`storage`, `modelProvider`, `channels`, `observers`, `healthChecks`) in place of the declared ones.
 * A fresh object — the `@Application` declaration is never changed, so two assemblies of one class
 * under two profiles never see each other.
 */
async function effectiveOptionsOf(
  declaration: Pick<ApplicationDeclaration, "options" | "written">,
  folded: FoldedConfig,
  replacements: AssemblyReplacements = {},
): Promise<ApplicationOptions> {
  const own = Object.fromEntries(
    Object.entries(replacements).filter(([, value]) => value !== undefined),
  );
  // a profile that replaces `storage` is the application's own choice: no temporary file then
  const written =
    folded.replacements.storage === undefined
      ? await withIsolatedStorage(
          declaration.written,
          placementOverridesOf(folded, declaration.written.workflows),
        )
      : declaration.written;
  const replaced = { ...written, ...folded.replacements, ...own };
  // the database storage and the mesh the profiles' shelves change: a derived class, the declared one untouched
  const changed = componentOptionsOf(replaced, folded);
  if (
    written === declaration.written &&
    Object.keys(folded.replacements).length === 0 &&
    Object.keys(own).length === 0 &&
    Object.keys(changed).length === 0
  )
    return declaration.options;
  // the replaced lists go through the same step as the declared ones: a replaced `storage` replaces
  // its stores in `providers`, a replaced `channels` its channels
  return declaredOptionsOf({ ...replaced, ...changed });
}

/** The providers the application's workflows can reach, by their `name`. */
const namesOf = (providers: readonly ModelProviderType[]): Map<string, ModelProviderType> =>
  new Map(providers.map((cls) => [modelProviderOf(cls).name, cls]));

/** A profile's provider overlays name providers the application has, and `models` only on a driver one. */
export function checkProviderOverlays(
  folded: FoldedConfig,
  reachable: readonly ModelProviderType[],
): void {
  const byName = namesOf(reachable);
  const profiles = folded.profiles.join(",");
  for (const [name, overlay] of Object.entries(folded.modelProviders)) {
    const cls = byName.get(name);
    if (cls === undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Unknown,
        message: `profile ${profiles}: modelProviders.${name}: no such model provider in the application — it has: ${[...byName.keys()].join(", ") || "none"}`,
      });
    if (!isDriverOptions(modelProviderOf(cls)) && (overlay.model ?? overlay.models) !== undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Invalid,
        message: `profile ${profiles}: modelProviders.${name}: ${name} serves models by name (serves), it has no model or models to change`,
      });
  }
}

/**
 * The workflow with what the profiles give the application: its budgets and the options of its
 * components. A run of it on its own (eval, replay, compare) counts and is bounded as the application is.
 */
export const withAppliedProfiles = (
  bundle: AssembledWorkflow,
  {
    budgetOverlays,
    componentOptions,
  }: Pick<AppliedProfiles, "budgetOverlays" | "componentOptions">,
): AssembledWorkflow => ({
  ...bundle,
  ...(budgetOverlays === undefined ? {} : { budgetOverlays }),
  componentOptions,
});

/** What an assembled application records of its profiles: their names and their `configureEnv` values. */
export interface ProfileFields {
  /** The options of the components under the profiles (#1318c): the one carrier every reader asks. */
  readonly componentOptions: ComponentOptions;
  /** What the profiles change of the pause targets, by target name; every reader of a target's deadline sees it. */
  readonly pauseOverrides?: PauseTargetOverrides | undefined;
  readonly profiles: readonly string[];
  readonly envOverrides: readonly EnvOverrides<EnvContract>[];
}

/** The selected profiles folded, the options under them, and what their overlays reached so far. */
export interface AppliedProfiles {
  readonly folded: FoldedConfig;
  /** The file `@Application` is declared in. */
  readonly source: string | undefined;
  readonly options: ApplicationOptions;
  /** The limits the profiles give the application's budgets, by budget name; absent when none. */
  readonly budgetOverlays?: BudgetOverlays | undefined;
  /** The options of the components under the profiles: every reader of a component's options asks it. */
  readonly componentOptions: ComponentOptions;
  /** What a workflow's profile overlays change while it is assembled. */
  readonly patchOf: (workflow: Class) => WorkflowPatch;
  /** What the overlays reached: what is left over after assembly is a typo. */
  readonly use: OverlayUse;
}

/** Loads the selected profiles (`src/config/` next to the application file) and applies them to the options. */
export async function appliedProfilesOf(
  declaration: ApplicationDeclaration,
  assembly: ApplicationAssembly,
): Promise<AppliedProfiles> {
  const folded = await foldedConfigFor(declaration.source, {
    profile: assembly.profile,
    defaultProfile: assembly.defaultProfile ?? APP_DEFAULT_PROFILE,
  });
  const use = new OverlayUse();
  const options = await effectiveOptionsOf(declaration, folded, assembly.replacements);
  const budgetOverlays = budgetOverlaysOf(folded, options);
  const componentOptions = optionCarrierOf(folded, options);
  return {
    folded,
    source: declaration.source,
    options,
    budgetOverlays,
    componentOptions,
    patchOf: (workflow) =>
      workflowPatchOf(
        folded,
        workflowDeclarationOf(workflow).options.name,
        use,
        [options.modelProvider, ...(options.providers ?? [])].filter(
          (cls): cls is Class => typeof cls === "function" && isModelProviderClass(cls),
        ),
        componentOptions,
      ),
    use,
  };
}

/** What an assembled application records of its profiles. */
export const profileFieldsOf = ({ folded, componentOptions }: AppliedProfiles): ProfileFields => ({
  componentOptions,
  pauseOverrides: pauseOverridesOf(folded),
  profiles: folded.profiles,
  envOverrides: folded.env,
});

/** The model providers the application's workflows can reach: its own, its workflows' and its default. */
const reachableProvidersOf = (
  options: ApplicationOptions,
  workflows: readonly AssembledWorkflow[],
): ModelProviderType[] => [
  ...new Set([
    ...workflows.flatMap((workflow) => workflow.modelProviders),
    ...(options.modelProvider === undefined ? [] : [options.modelProvider as ModelProviderType]),
  ]),
];

/** After every workflow is assembled: what the profiles name that nothing has is a typo. */
export function checkAppliedProfiles(
  applied: AppliedProfiles,
  assembled: readonly AssembledWorkflow[],
): void {
  checkOverlayUse(applied.folded, applied.use);
  checkMcpServers(applied.folded, assembled);
  checkMemories(applied.folded, assembled);
  checkComponentShelves(applied.folded, applied.options);
  checkPauseTargets(applied.folded, assembled);
  checkProviderOverlays(applied.folded, reachableProvidersOf(applied.options, assembled));
}
