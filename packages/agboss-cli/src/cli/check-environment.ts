import { ConfigError } from "@agboss/core";
import {
  createStartComponents,
  describeServices,
  contextsOutsideExecution,
  referencedVariablesOf,
  VariableUse,
  type AssembledApplication,
} from "@agboss/core/internal";
import type { CheckProblem } from "./check-problems.js";
import { flagOption, type CommandContext } from "./context.js";

/** What the environment check reads: the application and the process env. */
export interface EnvironmentTarget {
  readonly context: CommandContext;
  readonly file: string;
  readonly assembled: AssembledApplication;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Whether the secrets' values are needed (`--models`, which connects); else the check reads the
   * contract's shape and a secret whose variable is unset is no problem (#266).
   */
  readonly needsSecrets: boolean;
}

/** `[di.missing-provider] …` → its code; another component error is the app's start failing. */
const componentCode = (
  error: ConfigError.Component | ConfigError.Prompt | ConfigError.NoDefaultRouter,
): string => /^\[([a-z][\w.-]*)\]/.exec(error.message)?.[1] ?? "workflow.start";

/** `[environment.missing-variable] …` → its rule. */
const ruleOf = (message: string): string | undefined => /^\[([a-z][\w.-]*)\]/.exec(message)?.[1];

const problemOf = (file: string, error: unknown): CheckProblem[] => {
  if (error instanceof ConfigError.Environment)
    return [
      { file, code: error.envCode ?? ruleOf(error.message) ?? error.code, message: error.message },
    ];
  if (
    error instanceof ConfigError.Component ||
    error instanceof ConfigError.Prompt ||
    error instanceof ConfigError.NoDefaultRouter
  )
    return [{ file, code: componentCode(error), message: error.message }];
  throw error;
};

/**
 * `agboss check --strict`: a required variable the process does not set is a problem — a secret's only
 * with `--models`, which connects (types and assembly need no key, #266). Without `--strict` the report
 * names them (`not set`) and nothing fails.
 */
const unsetVariables = (target: EnvironmentTarget): CheckProblem[] =>
  !flagOption(target.context.values, "strict")
    ? []
    : referencedVariablesOf(target.assembled)
        .filter(
          (found) =>
            found.required &&
            (found.use === VariableUse.Value || target.needsSecrets) &&
            (target.env[found.variable] ?? "") === "",
        )
        .map((found) => ({
          file: target.file,
          code: "environment.missing-variable",
          message: `[environment.missing-variable] ${found.variable} is not set (${found.field})`,
        }));

/**
 * `agboss check` without running anything: every component the app's start creates (tools,
 * observers, judges, channels, …) of every workflow gets its dependencies (#239, #261). The process
 * variables the application needs are the report's (`check-report.ts`, #268 AC5); checking that
 * they are set is `agboss check`'s `defineEnv` walk (#1324h).
 */
export function environmentProblems(target: EnvironmentTarget): Promise<CheckProblem[]> {
  const unset = unsetVariables(target);
  if (unset.length > 0) return Promise.resolve(unset);
  try {
    const { router } = describeServices;
    for (const bundle of target.assembled.workflows)
      createStartComponents(bundle, {
        router,
        contexts: contextsOutsideExecution(bundle.config),
      });
    return Promise.resolve([]);
  } catch (error) {
    return Promise.resolve(problemOf(target.file, error));
  }
}
