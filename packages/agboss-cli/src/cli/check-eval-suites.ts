import { relative } from "node:path";
import { ComponentError, EvalCaseInvalidError, GraphRuleError, type Class } from "agboss";
import { checkEvalSuite, loadEvalSuites, type FoundEvalSuite } from "agboss/internal";
import type { CheckProblem } from "./check-problems.js";
import { loadOptions, type CommandContext } from "./context.js";

/**
 * Loop 0 of the eval pipeline (#396 PR 2, S5): `agboss check` finds the application's
 * `eval-suites/*.eval-suite.ts` and assembles each on it, as `agboss eval run` would before running
 * anything — its rules (`[eval.unknown-start]`, `[eval.duplicate-case]`, `[eval.judge-wrong-reply]`,
 * a judge's own) and its cases' values (`eval.case-invalid`), each a problem of the suite's file.
 */

/** What the check found: whether the application has suites, and their problems. */
export interface EvalSuitesCheck {
  readonly suites: number;
  readonly problems: readonly CheckProblem[];
}

const RULE_CODE = /^\[([\w.-]+)\]\s*/;

function problemsOf(file: string, error: unknown): CheckProblem[] {
  if (error instanceof GraphRuleError)
    return error.violations.map((found) => ({ file, code: found.code, message: found.message }));
  if (error instanceof EvalCaseInvalidError)
    return error.issues.map((issue) => ({
      file,
      code: EvalCaseInvalidError.code,
      message: `${error.suite}: case "${issue.case}": ${issue.path} — ${issue.reason}`,
    }));
  if (error instanceof ComponentError) {
    const code = RULE_CODE.exec(error.message)?.[1] ?? "workflow.assembly";
    return [{ file, code, message: error.message.replace(RULE_CODE, "") }];
  }
  throw error;
}

function problemsOfSuite(context: CommandContext, application: Class, found: FoundEvalSuite) {
  // from the working directory when the suite is under it, else its absolute path
  const shown = relative(context.io.cwd, found.file);
  const file = shown.startsWith("..") ? found.file : shown;
  try {
    checkEvalSuite(application, found.suite);
    return [];
  } catch (error) {
    return problemsOf(file, error);
  }
}

/** Every suite of the application, checked. */
export async function evalSuiteProblems(
  context: CommandContext,
  application: Class,
): Promise<EvalSuitesCheck> {
  const suites = await loadEvalSuites(application, loadOptions(context));
  const problems = suites.flatMap((found) => problemsOfSuite(context, application, found));
  return { suites: suites.length, problems };
}
