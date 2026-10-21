import { ComponentError, EnvironmentError } from "agboss";
import {
  createStartComponents,
  describeServices,
  environmentOwnerOf,
  environmentVariablesOf,
  resolveEnvironment,
  SecretResolution,
  selectedEnvironment,
  standaloneContexts,
  type AssembledApplication,
  type ProcessVariable,
} from "agboss/internal";
import type { CheckProblem } from "./check-problems.js";
import type { CommandContext } from "./context.js";

/** What the environment check reads: the application, the `--env` name and the process env. */
export interface EnvironmentTarget {
  readonly context: CommandContext;
  readonly file: string;
  readonly assembled: AssembledApplication;
  readonly envName: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Whether the secrets' values are needed (`--models`, which connects); else the check reads the
   * contract's shape and a secret whose variable is unset is no problem (#266).
   */
  readonly needsSecrets: boolean;
}

/** `[di.missing-environment] …` → its code; another component error is the app's start failing. */
const componentCode = (error: ComponentError): string =>
  /^\[([a-z][\w.-]*)\]/.exec(error.message)?.[1] ?? "workflow.start";

const problemOf = (file: string, error: unknown): CheckProblem[] => {
  if (error instanceof EnvironmentError)
    return [{ file, code: error.code, message: error.message }];
  if (error instanceof ComponentError)
    return [{ file, code: componentCode(error), message: error.message }];
  throw error;
};

/** How a variable is needed: required, with a default, or optional (`env.optional`, #266 S90). */
const presenceLabel = (found: ProcessVariable): string => {
  if (found.optional) return " (optional)";
  return found.required ? "" : " (has a default)";
};

/** `  OPENROUTER_API_KEY  secret → openRouterApiKey`: one process variable of `--env <name>` (#261 AC9). */
const variableLine = (found: ProcessVariable): string =>
  `  ${found.variable}  ${found.use}${presenceLabel(found)} → ${found.field}`;

/**
 * `agboss check` without running anything: the selected environment is found, every variable it
 * reads is set — its secrets only with `--models`, which connects (writing types and checking the
 * assembly need no key, #266) — and every component the app's start creates (tools, observers, judges, channels, …)
 * of every workflow gets its dependencies — `applicationContext.environment` the selected environment's values, empty
 * without one (#239, #261). With `--env` it
 * lists the process variables that environment needs, marked value / secret.
 */
export async function environmentProblems(target: EnvironmentTarget): Promise<CheckProblem[]> {
  try {
    const loaded = await selectedEnvironment(environmentOwnerOf(target.assembled), target.envName);
    if (loaded !== undefined && target.envName !== undefined) {
      target.context.say(`environment ${loaded.name}: process variables`);
      for (const found of environmentVariablesOf(loaded)) target.context.say(variableLine(found));
    }
    const secrets = target.needsSecrets ? SecretResolution.Required : SecretResolution.Deferred;
    const environment =
      loaded === undefined ? undefined : resolveEnvironment(loaded, target.env, secrets);
    const { router } = describeServices;
    for (const bundle of target.assembled.workflows)
      createStartComponents(bundle, {
        router,
        contexts: standaloneContexts(bundle.config, environment),
      });
    return [];
  } catch (error) {
    return problemOf(target.file, error);
  }
}
