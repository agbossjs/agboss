import { ComponentError, GraphRuleError } from "@agboss/core";
import { ConfigurationError, type ModelProblem } from "@agboss/core/models";
import { ProfileError, type AssembledApplication } from "@agboss/core/internal";
import { promptProblemsOf } from "./check-prompts.js";

/** One problem `agboss check` found: `file:line code message`. */
export interface CheckProblem {
  readonly file: string;
  readonly line?: number;
  readonly code: string;
  readonly message: string;
  /** `--federation` (#398 PR 4): the consumer's workflows a contract problem touches. */
  readonly blastRadius?: readonly {
    readonly application: string;
    readonly workflow: string;
    readonly tool: string;
  }[];
}

export const problemText = (problem: CheckProblem): string =>
  `${problem.file}${problem.line === undefined ? "" : `:${String(problem.line)}`} ${problem.code} ${problem.message}`;

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
    return error.violations.map((v) => ({ file, code: v.code, message: v.message }));
  if (error instanceof ConfigurationError)
    return error.problems.map((problem) => modelProblem(file, problem));
  const codes: readonly (readonly [new (...args: never[]) => Error, string])[] = [
    [ComponentError, "workflow.assembly"],
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
