import {
  createAppDeps,
  withProfile,
  type AppDeps,
  type AssembledWorkflow,
  type Environment,
} from "agboss";
import {
  applicationEnvironment,
  assembleApplication,
  loadChosenStart,
  workflowOfStart,
} from "../cli/cli-application.js";
import type { CommandContext } from "../cli/context.js";

/** The workflow `--start` opens, assembled in its application, and the `--env` environment. */
export interface StartWorkflow {
  readonly bundle: AssembledWorkflow;
  readonly environment: Environment | undefined;
}

/** The workflow of the chosen start with a profile (eval, replay, golden and compare work on it). */
export async function startWorkflowOf(
  context: CommandContext,
  profile: string | undefined,
): Promise<StartWorkflow> {
  const chosen = await loadChosenStart(context);
  // the profile is the start's workflow's own: profiles/<workflow>/<profile>.yaml
  const assembled = await assembleApplication(context, chosen);
  const bundle = workflowOfStart(assembled, chosen.start);
  return {
    bundle: await withProfile(bundle, profile, context.io.cwd),
    environment: await applicationEnvironment(context, assembled),
  };
}

/** The app parts of the chosen start's workflow with a profile. */
export async function depsFor(
  context: CommandContext,
  profile: string | undefined,
): Promise<AppDeps> {
  const { bundle, environment } = await startWorkflowOf(context, profile);
  const deps = await createAppDeps(bundle, {
    processEnv: context.io.env,
    ...(environment === undefined ? {} : { environment }),
  });
  deps.warnings.forEach((warning) => {
    context.warn(`warning: ${warning}`);
  });
  return deps;
}
