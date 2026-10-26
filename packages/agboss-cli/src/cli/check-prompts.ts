import { PromptError, type PromptProblem } from "@agboss/core";
import type { CheckProblem } from "./check-problems.js";

/** `prompts/x.md:3 {{typo}} — known: …` → that file and line; anything else stays with the workflow. */
const LOCATED = /^([^\s:]+):(\d+) ([\s\S]*)$/;

function promptProblem(workflow: string, problem: PromptProblem): CheckProblem {
  const located = LOCATED.exec(problem.message);
  if (located?.[1] === undefined || located[2] === undefined || located[3] === undefined)
    return { file: workflow, code: problem.code, message: problem.message };
  return { file: located[1], line: Number(located[2]), code: problem.code, message: located[3] };
}

/**
 * The `prompts` check of `agboss check` (#199): assembly reads every prompt (agents, routers, routes) and
 * checks its `{{variables}}` and files, throwing one `PromptError` with all problems — here each
 * becomes its own `file[:line] code message` problem. Undefined: not a prompt error.
 */
export function promptProblemsOf(
  workflow: string,
  error: unknown,
): readonly CheckProblem[] | undefined {
  if (!(error instanceof PromptError)) return undefined;
  return error.problems.map((problem) => promptProblem(workflow, problem));
}
