import { createHash } from "node:crypto";
import { ExecutionStatus } from "../../app/types.js";
import { nameOf } from "../../components/name-of.js";
import { sortedJson } from "../../flow/runtime/json.js";
import { turnsOfCase, type EvalCase } from "../suite/cases.js";
import { checksOf, toolsOf, type EvalCascade } from "../suite/checks.js";
import type { EvalSuiteMeta } from "../suite/eval-suite.decorator.js";
import { checkNameOf } from "./case-run.js";

/**
 * The hash of a case as written (#396 PR 2, S2 Q7): its values, its tools' expectations (an
 * invariant by its source), its judges, the suite's checks and cascade, its variants under
 * `--metamorphic` — what a later run compares
 * before it compares outcomes: a changed case is `Changed`, never `Regressed`.
 */

/** `--metamorphic` checks the variants too (#396 PR 7): another hash, never compared with a run without. */
function metamorphicDataOf(written: EvalCase, isMetamorphic: boolean) {
  const variants = isMetamorphic ? (written.variants ?? []).map((turn) => turn.input) : [];
  return variants.length === 0 ? {} : { metamorphic: variants };
}

/** The case as plain data, every class by its `name`. */
function caseDataOf(
  written: EvalCase,
  suite: Pick<EvalSuiteMeta, "judges" | "tools">,
  cascade: EvalCascade,
  isMetamorphic: boolean,
) {
  const tools = toolsOf(suite.tools, written.tools);
  return {
    ...metamorphicDataOf(written, isMetamorphic),
    name: written.name,
    tenant: written.tenant,
    execution: written.execution,
    history: (written.history ?? []).map((past) => ({
      start: nameOf(past.start),
      input: past.input,
      finish: nameOf(past.finish),
      output: past.output,
    })),
    turns: turnsOfCase(written).map((turn) => turn.input),
    tools: {
      required: (tools?.required ?? []).map((call) => ({
        tool: nameOf(call.tool),
        input: call.input,
      })),
      forbidden: (tools?.forbidden ?? []).map((tool) => nameOf(tool)),
      invariants: (tools?.invariants ?? []).map((invariant) => ({
        tool: nameOf(invariant.tool),
        holds: invariant.holds.toString(),
      })),
    },
    checks: checksOf(suite, written).map(checkNameOf),
    expectedStatus: written.expectedStatus ?? ExecutionStatus.Finished,
    cascade,
  };
}

/** The first 16 hex characters of the SHA-256 of the case's data. */
export const caseHashOf = (
  written: EvalCase,
  suite: Pick<EvalSuiteMeta, "judges" | "tools">,
  cascade: EvalCascade,
  isMetamorphic = false,
): string =>
  createHash("sha256")
    .update(sortedJson(caseDataOf(written, suite, cascade, isMetamorphic)))
    .digest("hex")
    .slice(0, 16);
