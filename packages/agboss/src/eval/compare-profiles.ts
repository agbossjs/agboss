import { createAppDeps, type AppDeps, type AppDepsOptions } from "../app/app-deps.js";
import type { Class } from "../components/injection.js";
import { ProfileError } from "../config/profiles.js";
import { environmentFor } from "../environments/load.js";
import { applicationOf, type AssembledApplication } from "../application/assemble.js";
import { startsOfApplication } from "../application/application-starts.js";
import { environmentOwnerOf } from "../application/create-app.js";
import type { ApplicationClass } from "../application/types.js";
import { nameOf } from "../components/name-of.js";
import { withProfile } from "../profile-workflow.js";
import type { AssembledWorkflow } from "../workflow.js";
import { pairwise, runProfile, type ProfileOutcome } from "./compare.js";
import { configDiff, profileReport, type ProfileReport } from "./compare-report.js";

/** An A/B (A/B/C…) of profiles on the same tasks: one row per profile, the first is the baseline. */
export interface ProfileComparison {
  readonly tasks: number;
  readonly profiles: readonly ProfileReport[];
  /** Startup warnings of the profiles' apps (e.g. a config changed without a version bump). */
  readonly warnings: readonly string[];
}

/**
 * `compareProfiles` options: the start whose workflow is compared, the profiles, the tasks, and any
 * app part instead of its default.
 */
export interface CompareProfilesOptions extends AppDepsOptions {
  /** A start of the application: its workflow is the one compared (#396 PR 5). */
  readonly start: Class;
  /** At least two; the first is the baseline; `base` is the workflow without a profile. */
  readonly profiles: readonly string[];
  readonly tasks: readonly string[];
  /** The environment name, as `createApp`'s `env`. */
  readonly env?: string | undefined;
  /** `profiles/<workflow>/<profile>.yaml` under it (default: the working directory). */
  readonly profileRoot?: string;
}

interface ProfileRun {
  readonly name: string;
  readonly deps: AppDeps;
}

async function compareRuns(
  runs: readonly ProfileRun[],
  tasks: readonly string[],
): Promise<ProfileReport[]> {
  const [base] = runs;
  const outcomes: ProfileOutcome[] = [];
  for (const run of runs)
    outcomes.push(await runProfile({ ...run, evaluation: run.deps.evaluation }, tasks));
  const [baseline] = outcomes;
  const rows: ProfileReport[] = [];
  for (const [i, outcome] of outcomes.entries()) {
    const other = runs[i];
    if (base === undefined || baseline === undefined || other === undefined) continue;
    const pair = i === 0 ? null : await pairwise(base.deps.evaluation, tasks, baseline, outcome);
    rows.push(profileReport(outcome, pair, i === 0 ? [] : configDiff(base.deps, other.deps)));
  }
  return rows;
}

/**
 * The one A/B engine (`agboss compare` runs it too): builds the app parts of every profile, runs each
 * task as a first contact within the application's budgets, scores it with the workflow's judge (through the
 * model gateway), judges every profile pairwise against the first, and closes the apps.
 */
export async function compareBundleProfiles(
  bundle: AssembledWorkflow,
  names: readonly string[],
  options: AppDepsOptions & { readonly profileRoot?: string },
  tasksOf: (base: AppDeps) => Promise<readonly string[]>,
): Promise<ProfileComparison> {
  if (names.length < 2) {
    throw new ProfileError(`compare needs at least two profiles, e.g. base,<profile>`);
  }
  const runs = await Promise.all(
    names.map(async (name) => ({
      name,
      deps: await createAppDeps(await withProfile(bundle, name, options.profileRoot), options),
    })),
  );
  try {
    const [base] = runs;
    const tasks = base === undefined ? [] : await tasksOf(base.deps);
    return {
      tasks: tasks.length,
      profiles: await compareRuns(runs, tasks),
      warnings: [...new Set(runs.flatMap((run) => run.deps.warnings))],
    };
  } finally {
    await Promise.all(runs.map((run) => run.deps.close()));
  }
}

const WHERE = "compareProfiles";

/** The workflow `start` opens in the application, assembled as `createApp` assembles it. */
function workflowOfStart(
  application: Class,
  assembled: AssembledApplication,
  start: Class,
): AssembledWorkflow {
  const found = startsOfApplication(application, WHERE).find(
    (candidate) => candidate.component === start,
  );
  if (found === undefined)
    throw new ProfileError(`${nameOf(start)} is not a start of ${nameOf(application)}`);
  const workflow = assembled.workflows.find((each) => each.config.name === found.workflow);
  if (workflow === undefined)
    throw new ProfileError(`${found.workflow} is not assembled in ${assembled.name}`);
  return workflow;
}

/**
 * A/B of profiles of the workflow a start opens, on the given tasks —
 * `compareProfiles(JobScoutApplication, { start: ScreeningWorkflowStart, profiles: ["base",
 * "scout-low-thinking"], tasks })` (#396 PR 5: on the application, as `createApp` builds it — its
 * providers, defaults and environment): the same app parts as `createApp` (pass `gateway`, `stores`,
 * `processEnv`… to replace them, e.g. scripted models in a test).
 */
export async function compareProfiles<TApplication extends Class>(
  application: ApplicationClass<TApplication>,
  options: CompareProfilesOptions,
): Promise<ProfileComparison> {
  const assembled = await applicationOf(application, {}, WHERE);
  const workflow = workflowOfStart(application, assembled, options.start);
  const environment = await environmentFor(
    environmentOwnerOf(assembled),
    options,
    options.processEnv ?? process.env,
  );
  return compareBundleProfiles(
    workflow,
    options.profiles,
    { ...options, ...(environment === undefined ? {} : { environment }) },
    () => Promise.resolve(options.tasks),
  );
}
