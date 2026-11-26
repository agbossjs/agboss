import { ComponentKind } from "../../runtime/records.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { OneOfProblem } from "../one-of.js";
import { childClassOf, EdgeKind, outputOf } from "../flow-graph.js";
import { childWorkflowOf } from "../child-workflow.js";
import type { DtoClass } from "../../../dto/types.js";
import { Wrapper, type OutputShape } from "../../dto-wrappers.js";
import type { ComponentName } from "../../registry.js";
import { classLabel, shapeLabel } from "../labels.js";
import type { AnalysisContext } from "./context.js";

/**
 * `.toOneOf([…])` takes exactly one branch per variant of the `oneOf` of the step it follows
 * (#1275): a variant no branch reads, or a branch that cannot be matched to one → the codes
 * `[flow.one-of-not-exhaustive]` / `[flow.one-of-ambiguous]`. Reordering the branches changes nothing.
 * A transition right after a step with a `oneOf` output, without a `.toOneOf(…)`, is
 * `[flow.one-of-not-exhaustive]` too.
 */

/** The classes of a `oneOf(…)` output; none for any other shape. */
export const variantsOf = (output: OutputShape | undefined): readonly DtoClass[] =>
  output !== undefined && typeof output !== "function" && output.kind === Wrapper.OneOf
    ? output.variants
    : [];

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

/** The finishes `.onFinish(F, …)` names must be the child's, once each, and cover every one of them. */
function onFinishViolations(context: AnalysisContext): readonly RuleViolation[] {
  const byNode = new Map<ComponentName, (typeof context.walked.onFinishes)[number][]>();
  for (const site of context.walked.onFinishes)
    byNode.set(site.node, [...(byNode.get(site.node) ?? []), site]);
  return [...byNode].flatMap(([name, sites]) => {
    const node = context.graph.nodes.get(name);
    const child =
      node?.kind === ComponentKind.Workflow ? childWorkflowOf(childClassOf(node)) : undefined;
    if (child === undefined) {
      const message = `${name}: .onFinish(F, …) follows a child workflow — .toWorkflow(W)`;
      return [violation("flow.one-of-ambiguous", message, [name])];
    }
    const named = sites.map((site) => site.step.finish);
    const unknown = named.filter((finish) => !child.finishes.includes(finish));
    const twice = named.filter((finish, at) => named.indexOf(finish) !== at);
    const missing = child.finishes.filter((finish) => !named.includes(finish));
    const mixed = context.graph.edges.some(
      (edge) => edge.from === name && edge.kind === EdgeKind.Next,
    );
    return [
      ...unknown.map((finish) => {
        const message = `${name}: .onFinish(${classLabel(finish)}, …) — ${classLabel(finish)} is no finish of ${child.name}`;
        return violation("flow.one-of-ambiguous", message, [name]);
      }),
      ...twice.map((finish) => {
        const message = `${name}: .onFinish(${classLabel(finish)}, …) is written twice — a finish has one path`;
        return violation("flow.one-of-ambiguous", message, [name]);
      }),
      ...missing.map((finish) => {
        const message = `${name} can end at ${classLabel(finish)} — add .onFinish(${classLabel(finish)}, …)`;
        return violation("flow.one-of-not-exhaustive", message, [name]);
      }),
      ...(mixed
        ? [
            violation(
              "flow.one-of-ambiguous",
              `${name}: .onFinish(F, …) and a transition after the same child — a child continues by its finishes or by one next step`,
              [name],
            ),
          ]
        : []),
    ];
  });
}

export const oneOfRules = (context: AnalysisContext): readonly RuleViolation[] => [
  ...oneOfViolations(context),
  ...onFinishViolations(context),
  ...unbranchedViolations(context),
];
