import { nameOf } from "../../components/name-of.js";
import type { ObservabilityMask } from "../../pii/observability-mask.js";
import type { EvalCase } from "../suite/cases.js";
import type { EvalCheck } from "../suite/checks.js";
import { checkNameOf } from "./case-run.js";
import type { EvalCaseExpectation } from "./trace.js";

/**
 * What a case expects, as the run artifact keeps it (#397 PR 2): its tools' expectations by name,
 * a required call's partial arguments masked like the trajectory they are read against, and its
 * checks in order — the page sets them beside each run's output.
 */
export async function caseExpectationOf(
  written: EvalCase,
  checks: readonly EvalCheck[],
  mask: ObservabilityMask | undefined,
): Promise<EvalCaseExpectation> {
  const tools = written.tools ?? {};
  const required = await Promise.all(
    (tools.required ?? []).map(async (expected) => ({
      tool: nameOf(expected.tool),
      ...(expected.arguments === undefined
        ? {}
        : {
            arguments:
              mask === undefined ? expected.arguments : await mask.value(expected.arguments),
          }),
    })),
  );
  return {
    requiredTools: required,
    forbiddenTools: (tools.forbidden ?? []).map((tool) => nameOf(tool)),
    invariantTools: (tools.invariants ?? []).map((invariant) => nameOf(invariant.tool)),
    checks: [...checks, ...(written.judges ?? [])].map(checkNameOf),
  };
}
