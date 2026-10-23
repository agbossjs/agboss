import { createHash } from "node:crypto";
import { nameOf } from "../../components/name-of.js";
import { sortedJson } from "../../flow/runtime/json.js";
import type { EvalCase } from "../suite/cases.js";
import type { EvalCascade, EvalCheck } from "../suite/checks.js";
import { checkNameOf } from "./case-run.js";

/**
 * The hash of a case as written (#396 PR 2, S2 Q7): its values, its tools' expectations (an
 * invariant by its source), its judges, the suite's checks and cascade — what a later run compares
 * before it compares outcomes: a changed case is `Changed`, never `Regressed`.
 */

/** The case as plain data, every class by its `name`. */
function caseDataOf(written: EvalCase, checks: readonly EvalCheck[], cascade: EvalCascade) {
  const { tools } = written;
  return {
    name: written.name,
    tenant: written.tenant,
    execution: written.execution,
    history: (written.history ?? []).map((past) => ({
      start: nameOf(past.start),
      input: past.input,
      finish: nameOf(past.finish),
      output: past.output,
    })),
    turns: written.turns.map((turn) => turn.input),
    tools: {
      required: (tools?.required ?? []).map((call) => ({
        tool: nameOf(call.tool),
        arguments: call.arguments,
      })),
      forbidden: (tools?.forbidden ?? []).map((tool) => nameOf(tool)),
      invariants: (tools?.invariants ?? []).map((invariant) => ({
        tool: nameOf(invariant.tool),
        holds: invariant.holds.toString(),
      })),
    },
    checks: [...checks, ...(written.judges ?? [])].map(checkNameOf),
    cascade,
  };
}

/** The first 16 hex characters of the SHA-256 of the case's data. */
export const caseHashOf = (
  written: EvalCase,
  checks: readonly EvalCheck[],
  cascade: EvalCascade,
): string =>
  createHash("sha256")
    .update(sortedJson(caseDataOf(written, checks, cascade)))
    .digest("hex")
    .slice(0, 16);
