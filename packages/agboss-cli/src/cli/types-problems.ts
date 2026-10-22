import type { CheckProblem } from "./check-problems.js";
import type { TypesOutcome } from "./flow-types.js";

/**
 * The types' problems merged with the assembly's (#371, #376): `agboss check` reports each once,
 * and never prints `ok` when `.agboss/types.d.ts` was not written.
 */

/** What the assembly's DTO clash says where it knows no file (`dtoClashMessage`). */
const UNKNOWN_FILE = "(unknown file)";

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `named` is `unnamed` with its "(unknown file)" filled in: the same code, the same classes
 * (#376) — type generation knows the files the assembly does not.
 */
function namesFilesOf(unnamed: CheckProblem, named: CheckProblem): boolean {
  if (named.code !== unnamed.code || !unnamed.message.includes(UNKNOWN_FILE)) return false;
  if (named.message.includes(UNKNOWN_FILE)) return false;
  const pattern = unnamed.message.split(UNKNOWN_FILE).map(escaped).join(".+?");
  return new RegExp(`^${pattern}$`).test(named.message);
}

/**
 * The types' problems beside the assembly's (#371): generation's own, and — when the file was not
 * written — each of its errors whose code the assembly does not report (a clash across workflows
 * that no single workflow's rules see). Generation fails only with an error, so a file not written
 * always leaves a problem: `agboss check` never prints `ok` without it.
 */
export const typesProblemsBeside = (
  outcome: TypesOutcome,
  assembly: readonly CheckProblem[],
): readonly CheckProblem[] => {
  const reported = new Set(assembly.map((problem) => problem.code));
  return [
    ...outcome.problems,
    ...outcome.unwritten.filter((problem) => !reported.has(problem.code)),
  ];
};

/**
 * Every problem of `agboss check`: the types' first, then the assembly's — an assembly diagnostic
 * that says "(unknown file)" replaced by generation's same one that names the files (#376 AC2).
 */
export function checkProblemsOf(
  outcome: TypesOutcome,
  assembly: readonly CheckProblem[],
): readonly CheckProblem[] {
  const named = assembly.map(
    (problem) => outcome.unwritten.find((found) => namesFilesOf(problem, found)) ?? problem,
  );
  return [...typesProblemsBeside(outcome, named), ...named];
}
