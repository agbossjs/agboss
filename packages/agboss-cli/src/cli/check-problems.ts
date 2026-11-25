import { ConfigError, GraphRuleError } from "@agboss/core";
import { ConfigurationError, type ModelProblem } from "@agboss/core/models";
import {
  diagnosticOfViolation,
  ProfileError,
  renderDiagnostic,
  ruleExplanationOf,
  type AssembledApplication,
  type Diagnostic,
} from "@agboss/core/internal";
import { promptProblemsOf } from "./check-prompts.js";

/** One problem `agboss check` found: `file:line code message`. */
export interface CheckProblem {
  readonly file: string;
  readonly line?: number;
  readonly code: string;
  readonly message: string;
  /**
   * The rule's places in the user's source (#1325c): where it is broken, what explains it. Printed
   * as a `rustc`-style snippet by `agboss check`; never part of the `--json` problem.
   */
  readonly diagnostic?: Diagnostic;
  /** `--federation` (#398 PR 4): the consumer's workflows a contract problem touches. */
  readonly blastRadius?: readonly {
    readonly application: string;
    readonly workflow: string;
    readonly tool: string;
  }[];
}

export const problemText = (problem: CheckProblem): string =>
  `${problem.file}${problem.line === undefined ? "" : `:${String(problem.line)}`} ${problem.code} ${problem.message}`;

/**
 * The problem as `agboss check` prints it: a `rustc`-style snippet when the rule's place in the
 * source is known, else the one line `file code message`.
 */
export function problemBlock(problem: CheckProblem): string {
  const { diagnostic } = problem;
  if (diagnostic?.primary === undefined) return problemText(problem);
  // a blank line after each snippet: the next problem starts apart
  return `${renderDiagnostic(diagnostic, { explainHint: ruleExplanationOf(problem.code) !== undefined })}\n`;
}

/** The problem as `--json` carries it: its places in the source stay in the text. */
export function jsonProblem(problem: CheckProblem): CheckProblem {
  const { diagnostic, ...rest } = problem;
  return diagnostic === undefined ? problem : rest;
}

export const modelProblem = (file: string, problem: ModelProblem): CheckProblem => ({
  file,
  code: problem.code,
  message: `${problem.key} = ${problem.value} — model ${problem.model}: ${problem.supported}`,
});

/** An assembly error → its problems (every rule violation separately); undefined = not a project error. */
function problemsOfError(file: string, error: unknown): readonly CheckProblem[] | undefined {
  const prompts = promptProblemsOf(file, error);
  if (prompts !== undefined) return prompts;
  if (error instanceof GraphRuleError)
    return error.violations.map((v) => ({
      file,
      code: v.code,
      message: v.message,
      diagnostic: diagnosticOfViolation(v),
    }));
  if (error instanceof ConfigurationError)
    return error.problems.map((problem) => modelProblem(file, problem));
  const codes: readonly (readonly [new (...args: never[]) => Error, string])[] = [
    [ConfigError.Component, "workflow.assembly"],
    [ConfigError.Prompt, "workflow.assembly"],
    [ConfigError.NoDefaultRouter, "workflow.assembly"],
    [ProfileError, "profile.invalid"],
  ];
  const known = codes.find(([type]) => error instanceof type);
  if (known === undefined || !(error instanceof Error)) return undefined;
  return [{ file, code: known[1], message: error.message.split("\n").join(" ") }];
}

export type Assembly =
  | { readonly kind: "ok"; readonly assembled: AssembledApplication }
  | { readonly kind: "failed"; readonly problems: readonly CheckProblem[] };

/** The application assembled (graph rules, DI, config, settings of every workflow), or its problems. */
export async function assemble(
  file: string,
  build: () => Promise<AssembledApplication>,
): Promise<Assembly> {
  try {
    return { kind: "ok", assembled: await build() };
  } catch (error) {
    const problems = problemsOfError(file, error);
    if (problems === undefined) throw error;
    return { kind: "failed", problems };
  }
}
