import type { Environment } from "@agboss/core";
import type { AssembledWorkflow } from "@agboss/core/internal";
import { createAppDeps, type AppDeps } from "@agboss/core/internal";
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
  profile: string | readonly string[] | undefined,
): Promise<StartWorkflow> {
  const chosen = await loadChosenStart(context);
  // the profiles are the application's: src/config/<name>.config.ts|yaml, applied as the app assembles
  const assembled = await assembleApplication(context, chosen, profile);
  return {
    bundle: workflowOfStart(assembled, chosen.start),
    environment: await applicationEnvironment(context, assembled),
  };
}

/** The app parts of the chosen start's workflow with a profile. */
export async function depsFor(
  context: CommandContext,
  profile: string | readonly string[] | undefined,
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
