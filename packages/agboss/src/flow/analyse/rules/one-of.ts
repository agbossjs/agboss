import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { OneOfProblem } from "../one-of.js";
import { EdgeKind, outputOf } from "../flow-graph.js";
import type { OutputShape } from "../../dto-wrappers.js";
import { shapeLabel } from "../labels.js";
import { variantsOf } from "./switch.js";
import type { AnalysisContext } from "./context.js";

/**
 * `.toOneOf([…])` takes exactly one branch per variant of the `oneOf` of the step it follows
 * (#1275): a variant no branch reads, or a branch that cannot be matched to one → the codes
 * `[flow.one-of-not-exhaustive]` / `[flow.one-of-ambiguous]`. Reordering the branches changes nothing.
 * A transition right after a step with a `oneOf` output, without a `.toOneOf(…)`, is
 * `[flow.one-of-not-exhaustive]` too.
 */

const givesOf = (output: OutputShape | undefined): string =>
  output === undefined ? "has no output" : `gives ${shapeLabel(output)}`;

function oneOfViolations(context: AnalysisContext): readonly RuleViolation[] {
  return context.walked.oneOfs.flatMap((site) => {
    const node = context.graph.nodes.get(site.node);
    const output = node === undefined ? undefined : outputOf(node);
    if (variantsOf(output).length === 0) {
      const gives = givesOf(output);
      const message =
        `${site.node} ${gives}, not a oneOf — .toOneOf([…]) follows a step with a oneOf output; ` +
        "continue with .to…(…) after it instead";
      return [violation("flow.one-of-ambiguous", message, [site.node])];
    }
    return site.resolution.findings.map(({ problem, message }) =>
      violation(
        problem === OneOfProblem.Missing ? "flow.one-of-not-exhaustive" : "flow.one-of-ambiguous",
        `${site.node} ${givesOf(output)}: ${message}`,
        [site.node],
      ),
    );
  });
}

/** A transition right after a step with a `oneOf` output: nothing branches it. */
function unbranchedViolations(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const edge of context.graph.edges) {
    const node = context.graph.nodes.get(edge.from);
    if (node === undefined || edge.kind === EdgeKind.Case || edge.kind === EdgeKind.Error) continue;
    const output = outputOf(node);
    if (variantsOf(output).length === 0 || found.has(node.name)) continue;
    const message = `${node.name} ${givesOf(output)} — branch it with .toOneOf([…])`;
    found.set(node.name, violation("flow.one-of-not-exhaustive", message, [node.name]));
  }
  return [...found.values()];
}

export const oneOfRules = (context: AnalysisContext): readonly RuleViolation[] => [
  ...oneOfViolations(context),
  ...unbranchedViolations(context),
];
