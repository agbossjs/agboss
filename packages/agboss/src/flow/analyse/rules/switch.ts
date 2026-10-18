import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { Wrapper, type OutputShape } from "../../dto-wrappers.js";
import { outputOf, type FlowNode } from "../flow-graph.js";
import { dtoLabel, shapeLabel } from "../labels.js";
import type { SwitchSite } from "../walked-flow.js";
import type { AnalysisContext } from "./context.js";

/**
 * `.switch(caseOf(…)…)` is exhaustive over the `oneOf` of the step it follows (#272 AC5): a missing
 * variant → `[flow.switch-not-exhaustive]`, a class the step does not give →
 * `[flow.switch-unknown-case]`. Reordering the cases changes nothing (sets). The `oneOf` is written
 * before the switch, `.returns(oneOf(…))`, and must be the step's output (#299 S54 c,
 * `[flow.returns-mismatch]`).
 */

const variantsOf = (output: OutputShape | undefined): readonly DtoClass[] =>
  output !== undefined && typeof output !== "function" && output.kind === Wrapper.OneOf
    ? output.variants
    : [];

const gives = (output: OutputShape | undefined): string =>
  output === undefined ? "has no output" : `gives ${shapeLabel(output)}`;

/** The `.returns(oneOf(…))` before the switch: present, and the step's output. */
function returnedViolation(node: FlowNode, site: SwitchSite): RuleViolation | undefined {
  const output = outputOf(node);
  if (output === undefined) return undefined;
  const want = shapeLabel(output);
  if (site.returned !== undefined && shapeLabel(site.returned) === want) return undefined;
  const message =
    site.returned === undefined
      ? `${node.name} gives ${want} — write .returns(${want}) before its .switch(…)`
      : `${node.name} gives ${want} — write .returns(${want}), not .returns(${shapeLabel(site.returned)})`;
  return violation("flow.returns-mismatch", message, [node.name]);
}

function switchViolations(node: FlowNode, site: SwitchSite): readonly RuleViolation[] {
  const output = outputOf(node);
  const variants = variantsOf(output);
  const cases = site.step.cases.map((branch) => branch.dto);
  if (variants.length === 0) {
    const message =
      `${node.name} ${gives(output)}, not a oneOf — .switch(caseOf(…)…) follows a step with a ` +
      "oneOf output; write .returns(…) after it instead";
    return [violation("flow.switch-unknown-case", message, [node.name])];
  }
  const returned = returnedViolation(node, site);
  const missing = variants.filter((variant) => !cases.includes(variant));
  const unknown = cases.filter((dto) => !variants.includes(dto));
  return [
    ...(returned === undefined ? [] : [returned]),
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

export function switchRules(context: AnalysisContext): readonly RuleViolation[] {
  return context.walked.switches.flatMap((site) => {
    const node = context.graph.nodes.get(site.node);
    return node === undefined ? [] : switchViolations(node, site);
  });
}
