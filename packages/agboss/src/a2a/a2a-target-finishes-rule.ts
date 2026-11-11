import { violation, type RuleViolation } from "../graph/rule-error.js";
import { hasKindSuffix, NameKind } from "../flow/names.js";
import type { A2AAgentMeta } from "./a2a-decorator.js";

/**
 * `[a2a.unknown-finish]` at assembly (#916): `@A2AAgent({ target: { finishes } })` names finishes of
 * the skill its typed `output` takes. What assembly can know without the remote card is refused here
 * — a list on an untyped agent (no output takes a finish), an empty list, a name that is no
 * `@WorkflowFinish` name (`…-workflow-finish`), a name twice; a well-formed name the skill does not
 * have is refused by the card check before anything is sent (`A2AContractRule.UnknownFinish`) and
 * by `agboss check --federation` against the receiver's snapshot.
 */

const CODE = "a2a.unknown-finish";

/** Why `finishes` names no finish a typed client could take; none when it can. */
function problemsOf(meta: A2AAgentMeta, finishes: readonly string[]): string[] {
  if (meta.output === undefined)
    return ["lists finishes but has no output DTO — only a typed agent takes some of them"];
  if (finishes.length === 0)
    return ["lists no finish — leave target.finishes out to take every finish of the skill"];
  const named = finishes.filter((finish) => !hasKindSuffix(finish, NameKind.WorkflowFinish));
  const repeated = finishes.filter((finish, index) => finishes.indexOf(finish) !== index);
  return [
    ...named.map((finish) => `"${finish}" is no @WorkflowFinish name (…-workflow-finish)`),
    ...[...new Set(repeated)].map((finish) => `"${finish}" is listed twice`),
  ];
}

/** The `target.finishes` violations of one `@A2AAgent`. */
export function targetFinishesViolations(meta: A2AAgentMeta, where: string): RuleViolation[] {
  const finishes = meta.target?.finishes;
  if (finishes === undefined) return [];
  return problemsOf(meta, finishes).map((problem) =>
    violation(CODE, `${meta.name}'s target.finishes ${problem}`, [where]),
  );
}
