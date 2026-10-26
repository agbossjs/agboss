import type { EvalCaseExpectation } from "@agboss/core/eval";
import { element, type HtmlElement } from "./html.js";
import { factsOf } from "./sections.js";

/**
 * What a case expects (#397 PR 2), set beside each run's output: the tools it requires (with the
 * partial their arguments must match), forbids and holds to an invariant, and its checks in order.
 */
export function expectationView(expectation: EvalCaseExpectation): HtmlElement {
  const required = expectation.requiredTools.map((expected) =>
    expected.arguments === undefined
      ? expected.tool
      : `${expected.tool} with ${JSON.stringify(expected.arguments)}`,
  );
  return element("div", { class: "expectation" }, [
    element("p", { class: "step-part-title" }, ["Expected"]),
    factsOf([
      ["Requires", required.join("; ")],
      ["Forbids", expectation.forbiddenTools.join(", ")],
      ["Invariants on", expectation.invariantTools.join(", ")],
      ["Checks, in order", expectation.checks.join(" → ")],
    ]),
  ]);
}
