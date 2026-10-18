import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { QuorumKind } from "../../ast.js";
import { Wrapper } from "../../dto-wrappers.js";
import type { JoinEdge } from "../flow-graph.js";
import type { JoinGroup } from "../join-groups.js";
import { launchLabel } from "../join-groups.js";
import { shapeLabel } from "../labels.js";
import { chain, sorted } from "./returns.js";

/**
 * What a quorum's `.returns(…)` may promise (#279 AC13, AC14), checked on the quorum itself: after
 * `.joinQuorum({ min })` with `min` below the agents launched a single answer is `optional(XDto)` —
 * a required `XDto` is `[flow.quorum-return-not-optional]`, not a missing input steps later; a
 * group's `.returns(…)` names exactly what its agents give (a repeated class as `listOf`); anything
 * else is `[flow.returns-mismatch]`.
 */

/** A single value a quorum may leave out, written required: the class's label. */
function promisedRequired(group: JoinGroup, got: readonly string[]): string | undefined {
  const { shape } = group;
  if (shape === undefined || typeof shape === "function" || shape.kind !== Wrapper.Optional)
    return undefined;
  const inner = shapeLabel(shape.inner);
  return got.includes(inner) ? inner : undefined;
}

function notOptional(join: JoinEdge, got: readonly string[]): readonly RuleViolation[] {
  const { launch, quorum } = join;
  if (quorum?.kind !== QuorumKind.Count) return [];
  return join.groups.flatMap((group) => {
    const inner = promisedRequired(group, got);
    if (inner === undefined) return [];
    const message =
      `${launchLabel(launch)}: .joinQuorum({ min: ${String(quorum.min)} }) may leave ` +
      `${group.producers.join(", ")} out of the quorum — write .returns(optional(${inner})), not ` +
      `.returns(${inner}) (or min: ${String(launch.listed.length)} to count every agent)`;
    return [violation("flow.quorum-return-not-optional", message, [launch.launcher])];
  });
}

/** `.joinQuorum(…).returns(…)` and each `group(…).returns(…)` against what the counted answers give. */
export function quorumReturnsViolations(join: JoinEdge): readonly RuleViolation[] {
  const { group } = join;
  const call = group === undefined ? ".joinQuorum(…)" : `group(${group.agents.join(", ")})`;
  const label = `${launchLabel(join.launch)}${group === undefined ? "" : ` ${call}`}`;
  const nodes = [join.launch.launcher];
  const problems = join.groups.flatMap((found) =>
    found.problem === undefined
      ? []
      : [violation("flow.returns-mismatch", `${label}: ${found.problem}`, nodes)],
  );
  const want = join.groups.flatMap((found) =>
    found.shape === undefined ? [] : [shapeLabel(found.shape)],
  );
  const got = join.written.map(shapeLabel);
  const promised = notOptional(join, got);
  if (problems.length > 0 || promised.length > 0) return [...problems, ...promised];
  if (sorted(want) === sorted(got)) return [];
  const message =
    `the counted answers of ${label} give ${sorted(want)} — write ${call}${chain(want)}` +
    (got.length === 0 ? "" : `, not ${call}${chain(got)}`);
  return [violation("flow.returns-mismatch", message, nodes)];
}
