import { ConfigError } from "@agboss/core";
import {
  createStartComponents,
  describeServices,
  contextsOutsideExecution,
  deferredEnvResolverOf,
  invalidVariablesOf,
  profileEnvOf,
  unsetVariablesOf,
  VariableUse,
  type AssembledApplication,
  type ProcessVariable,
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

/** A required variable that nothing gives: not the process, not the selected profile. */
const unsetRequired = (target: EnvironmentTarget): readonly ProcessVariable[] =>
  unsetVariablesOf(target.assembled, target.env);

/**
 * `agboss check --strict`: a required variable nothing sets — the process, or the profile's
 * `configureEnv` — is `[environment.missing-variable]` (a secret's only with `--models`, which
 * connects: types and assembly need no key, #266), and a variable that is set but that its reference
 * cannot read is `[environment.invalid-value]`; every reference of the application is walked, never
 * a value printed. Without `--strict` the report names the unset ones (`not set`) and nothing fails.
 */
function strictProblems(target: EnvironmentTarget): CheckProblem[] {
  if (!flagOption(target.context.values, "strict")) return [];
  const missing = unsetRequired(target)
    .filter((found) => found.use === VariableUse.Value || target.needsSecrets)
    .map((found) => ({
      file: target.file,
      code: "environment.missing-variable",
      message: `[environment.missing-variable] ${found.variable} is not set (${found.field})`,
    }));
  const invalid = invalidVariablesOf(target.assembled, target.env).map((found) => ({
    file: target.file,
    code: "environment.invalid-value",
    message: `[environment.invalid-value] ${found.variable} is not ${found.expected} (${found.field})`,
  }));
  return [...missing, ...invalid];
}

/**
 * A component whose own code threw while it was built on a placeholder (`new URL("")`): the report
 * says which variables stood in, never the error's text (user code may copy a value into it).
 */
function placeholderProblem(target: EnvironmentTarget): CheckProblem[] | undefined {
  const unset = unsetRequired(target);
  if (unset.length === 0) return undefined;
  return [
    {
      file: target.file,
      code: "environment.placeholder-failed",
      message: `[environment.placeholder-failed] a component could not be built while ${unset.map((found) => found.variable).join(", ")} ${unset.length === 1 ? "is" : "are"} not set: set ${unset.length === 1 ? "it" : "them"}, give ${unset.length === 1 ? "it" : "them"} a default, or read ${unset.length === 1 ? "it" : "them"} lazily, at use`,
    },
  ];
}

/**
 * `agboss check` without running anything: every component the app's start creates (tools,
 * observers, judges, channels, …) of every workflow gets its dependencies (#239, #261), on
 * placeholders for the variables nothing sets (check needs none, #266). The process variables the
 * application needs are the report's (`check-report.ts`, #268 AC5); `--strict` verifies them. Both
 * kinds of problem are reported together.
 */
export function environmentProblems(target: EnvironmentTarget): Promise<CheckProblem[]> {
  const strict = strictProblems(target);
  try {
    const { router } = describeServices;
    for (const bundle of target.assembled.workflows)
      createStartComponents(bundle, {
        router,
        contexts: contextsOutsideExecution(bundle.config),
        // the CLI's variables and the profile's configureEnv; what neither sets is a placeholder
        deferredEnv: deferredEnvResolverOf(profileEnvOf(bundle), target.env),
      });
    return Promise.resolve(strict);
  } catch (error) {
    if (
      !(error instanceof ConfigError.Environment) &&
      !(error instanceof ConfigError.Component) &&
      !(error instanceof ConfigError.Prompt) &&
      !(error instanceof ConfigError.NoDefaultRouter)
    ) {
      const placeholder = placeholderProblem(target);
      if (placeholder !== undefined) return Promise.resolve([...strict, ...placeholder]);
    }
    return Promise.resolve([...strict, ...problemOf(target.file, error)]);
  }
}
