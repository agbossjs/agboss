import { nameOf } from "../../components/name-of.js";
import type { ObservabilityMask } from "../../pii/observability-mask.js";
import type { EvalCase } from "../suite/cases.js";
import { checksOf, toolsOf } from "../suite/checks.js";
import type { EvalSuiteMeta } from "../suite/eval-suite.decorator.js";
import { checkNameOf } from "./case-run.js";
import type { EvalCaseExpectation } from "./trace.js";
import { METAMORPHIC_CHECK } from "./report.js";

/** The checks a case runs, in order: the suite's, its own judges, `metamorphic` last (#396 PR 7). */
function checkNamesOf(
  written: EvalCase,
  suite: Pick<EvalSuiteMeta, "judges" | "tools">,
  isMetamorphic: boolean,
): readonly string[] {
  const names = checksOf(suite, written).map(checkNameOf);
  const hasVariants = (written.variants?.length ?? 0) > 0;
  return isMetamorphic && hasVariants ? [...names, METAMORPHIC_CHECK] : names;
}

/**
 * What a case expects, as the run artifact keeps it (#397 PR 2): its tools' expectations by name,
 * a required call's partial arguments masked like the trajectory they are read against, and its
 * checks in order — the page sets them beside each run's output.
 */
export async function caseExpectationOf(
  written: EvalCase,
  suite: Pick<EvalSuiteMeta, "judges" | "tools">,
  mask: ObservabilityMask | undefined,
  isMetamorphic = false,
): Promise<EvalCaseExpectation> {
  const tools = toolsOf(suite.tools, written.tools) ?? {};
  const required = await Promise.all(
    (tools.required ?? []).map(async (expected) => ({
      tool: nameOf(expected.tool),
      ...(expected.input === undefined
        ? {}
        : {
            input: mask === undefined ? expected.input : await mask.value(expected.input),
          }),
    })),
  );
  return {
    requiredTools: required,
    forbiddenTools: (tools.forbidden ?? []).map((tool) => nameOf(tool)),
    invariantTools: (tools.invariants ?? []).map((invariant) => nameOf(invariant.tool)),
    checks: checkNamesOf(written, suite, isMetamorphic),
  };
}
