import { ComponentError, EnvironmentError, type AssembledWorkflow } from "agboss";
import {
  createStartComponents,
  describeServices,
  environmentVariablesOf,
  resolveEnvironment,
  selectedEnvironment,
  standaloneContexts,
  type ProcessVariable,
} from "agboss/internal";
import type { CheckProblem } from "./check-problems.js";
import type { CommandContext } from "./context.js";
import { environmentOwner } from "./environment.js";

/** What the environment check reads: the workflow, the `--env` name and the process env. */
export interface EnvironmentTarget {
  readonly context: CommandContext;
  readonly file: string;
  readonly bundle: AssembledWorkflow;
  readonly envName: string | undefined;
  readonly env: NodeJS.ProcessEnv;
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

/** `  OPENROUTER_API_KEY  secret → openRouterApiKey`: one process variable of `--env <name>` (#261 AC9). */
const variableLine = (found: ProcessVariable): string =>
  `  ${found.variable}  ${found.use}${found.required ? "" : " (has a default)"} → ${found.field}`;

/**
 * `agboss check` without running anything: the selected environment is found, every variable it
 * reads is set, and every component the app's start creates (tools, observers, judges, channels, …)
 * gets its dependencies — `applicationContext.environment` the selected environment's values, empty
 * without one (#239, #261). With `--env` it
 * lists the process variables that environment needs, marked value / secret.
 */
export async function environmentProblems(target: EnvironmentTarget): Promise<CheckProblem[]> {
  try {
    const owner = await environmentOwner(target.context, target.file);
    const loaded = await selectedEnvironment(owner, target.envName);
    if (loaded !== undefined && target.envName !== undefined) {
      target.context.say(`environment ${loaded.name}: process variables`);
      for (const found of environmentVariablesOf(loaded)) target.context.say(variableLine(found));
    }
    const environment = loaded === undefined ? undefined : resolveEnvironment(loaded, target.env);
    const { router } = describeServices;
    createStartComponents(target.bundle, {
      router,
      contexts: standaloneContexts(target.bundle.config, environment),
    });
    return [];
  } catch (error) {
    return problemOf(target.file, error);
  }
}
