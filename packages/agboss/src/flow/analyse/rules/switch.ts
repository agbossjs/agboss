import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { Wrapper, type OutputShape } from "../../dto-wrappers.js";
import { EdgeKind, outputOf, type FlowNode } from "../flow-graph.js";
import { dtoLabel, shapeLabel } from "../labels.js";
import type { SwitchSite } from "../walked-flow.js";
import type { AnalysisContext } from "./context.js";

/**
 * `.switch(caseOf(…)…)` is exhaustive over the `oneOf` of the step it follows (#272 AC5): a missing
 * variant → `[flow.switch-not-exhaustive]`, a class the step does not give →
 * `[flow.switch-unknown-case]`. Reordering the cases changes nothing (sets). The `oneOf` is the
 * step's `output`; a transition right after it, without the switch, is `[flow.switch-not-exhaustive]`.
 */

const variantsOf = (output: OutputShape | undefined): readonly DtoClass[] =>
  output !== undefined && typeof output !== "function" && output.kind === Wrapper.OneOf
    ? output.variants
    : [];

const gives = (output: OutputShape | undefined): string =>
  output === undefined ? "has no output" : `gives ${shapeLabel(output)}`;

function switchViolations(node: FlowNode, site: SwitchSite): readonly RuleViolation[] {
  const output = outputOf(node);
  const variants = variantsOf(output);
  const cases = site.step.cases.map((branch) => branch.dto);
  if (variants.length === 0) {
    const message =
      `${node.name} ${gives(output)}, not a oneOf — .switch(caseOf(…)…) follows a step with a ` +
      "oneOf output; continue with .to…(…) after it instead";
    return [violation("flow.switch-unknown-case", message, [node.name])];
  }
  const missing = variants.filter((variant) => !cases.includes(variant));
  const unknown = cases.filter((dto) => !variants.includes(dto));
  return [
    ...missing.map((dto) => {
      const message = `${node.name} ${gives(output)} — add caseOf(${dtoLabel(dto)})… to its switch`;
      return violation("flow.switch-not-exhaustive", message, [node.name]);
    }),
    ...unknown.map((dto) => {
      const message =
        `caseOf(${dtoLabel(dto)}): ${node.name} does not give ${dtoLabel(dto)} — it ` +
        gives(output);
      return violation("flow.switch-unknown-case", message, [node.name]);
    }),
  ];
}

/** A transition right after a step with a `oneOf` output: nothing branches it. */
function unswitchedViolations(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const edge of context.graph.edges) {
    const node = context.graph.nodes.get(edge.from);
    const output = node === undefined ? undefined : outputOf(node);
    if (node === undefined || edge.kind === EdgeKind.Case || edge.kind === EdgeKind.Error) continue;
    if (variantsOf(output).length === 0 || found.has(node.name)) continue;
    const message = `${node.name} ${gives(output)} — branch it with .switch(caseOf(…)…)`;
    found.set(node.name, violation("flow.switch-not-exhaustive", message, [node.name]));
  }
  return [...found.values()];
}

export function switchRules(context: AnalysisContext): readonly RuleViolation[] {
  const switched = context.walked.switches.flatMap((site) => {
    const node = context.graph.nodes.get(site.node);
    return node === undefined ? [] : switchViolations(node, site);
  });
  return [...switched, ...unswitchedViolations(context)];
}
