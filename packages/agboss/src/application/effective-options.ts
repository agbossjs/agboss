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
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { budgetOf } from "../budgets/budget.js";
import { budgetsOfApplication } from "../budgets/budget-rules.js";
import type { BudgetOverlay, BudgetOverlays } from "../budgets/budget-overlay.js";
import { usd } from "../units/index.js";
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
import type { ApplicationAssembly } from "./assembly-options.js";
import {
  declaredOptionsOf,
  type ApplicationDeclaration,
  type ApplicationOptions,
} from "./application.js";
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
): Promise<ApplicationOptions> {
  // a profile that replaces `storage` is the application's own choice: no temporary file then
  const written =
    folded.replacements.storage === undefined
      ? await withIsolatedStorage(declaration.written)
      : declaration.written;
  if (written === declaration.written && Object.keys(folded.replacements).length === 0)
    return declaration.options;
  // the replaced lists go through the same step as the declared ones: a replaced `storage` replaces
  // its stores in `providers`, a replaced `channels` its channels
  return declaredOptionsOf({ ...written, ...folded.replacements });
}

/** A YAML limit is a number: the branded dollars a budget takes. */
const limitOf = (overlay: BudgetOverlay): BudgetOverlay => ({
  ...overlay,
  ...(typeof overlay.maxSpend === "number" ? { maxSpend: usd(overlay.maxSpend) } : {}),
});

/**
 * The budget limits the profiles give, by budget name: every name is a budget of the application (listed or
 * attached), and a budget that reads its limits in `limit()` takes none — a profile cannot make it declare
 * them. `undefined` when no profile names a budget.
 */
function budgetOverlaysOf(
  folded: FoldedConfig,
  options: ApplicationOptions,
): BudgetOverlays | undefined {
  const named = Object.entries(folded.budgets);
  if (named.length === 0) return undefined;
  const metas = budgetsOfApplication({
    budgets: options.budgets,
    workflows: withChildWorkflows(options.workflows),
  }).flatMap((cls) => budgetOf(cls) ?? []);
  const profiles = folded.profiles.join(",");
  for (const [name] of named) {
    const meta = metas.find((one) => one.name === name);
    if (meta === undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Unknown,
        message: `profile ${profiles}: budgets.${name}: no such budget in the application — it has: ${metas.map((one) => one.name).join(", ") || "none"}`,
      });
    if (meta.maxSpend === undefined && meta.maxTokens === undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Invalid,
        message: `profile ${profiles}: budgets.${name}: ${name} reads its limits in limit(), a profile cannot set them — declare maxSpend / maxTokens in its @Budget`,
      });
  }
  return new Map(named.map(([name, overlay]) => [name, limitOf(overlay)]));
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

/** What an assembled application records of its profiles: their names and their `configureEnv` values. */
export interface ProfileFields {
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
  const options = await effectiveOptionsOf(declaration, folded);
  return {
    folded,
    source: declaration.source,
    options,
    budgetOverlays: budgetOverlaysOf(folded, options),
    patchOf: (workflow) =>
      workflowPatchOf(
        folded,
        workflowDeclarationOf(workflow).options.name,
        use,
        [options.modelProvider, ...(options.providers ?? [])].filter(
          (cls): cls is Class => typeof cls === "function" && isModelProviderClass(cls),
        ),
      ),
    use,
  };
}

/** What an assembled application records of its profiles. */
export const profileFieldsOf = ({ folded }: AppliedProfiles): ProfileFields => ({
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
  checkProviderOverlays(applied.folded, reachableProvidersOf(applied.options, assembled));
}
