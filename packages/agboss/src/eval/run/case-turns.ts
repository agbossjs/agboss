import { executeUnchecked } from "../../app/execute-unchecked.js";
import { ExecutionStatus, type ExecutionOutput } from "../../app/types.js";
import { AGBossError } from "../../core/errors.js";
import type { EvalCase } from "../suite/cases.js";
import type { CaseContextValues } from "./case-frame.js";
import type { SuiteRunParts } from "./case-run.js";
import type { EvalRunError } from "./report.js";

/**
 * The turns of one run of a case (#396 PR 2), in order on its thread through the application
 * (`app.execute`, the case's `tenant` / `execution` as validated) — the case's own, or a variant's
 * (`--metamorphic`, #396 PR 7): the same turns with the last one reworded.
 */

/** How the turns of a run went: the last turn's output, or why one could not end. */
export type TurnsOutcome =
  | { readonly kind: "ended"; readonly last: ExecutionOutput; readonly spentUsd: number }
  | { readonly kind: "failed"; readonly error: EvalRunError; readonly spentUsd: number };

const errorOf = (error: unknown): EvalRunError =>
  error instanceof AGBossError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : String(error) };

/** The turns in order on one thread; an earlier turn that pauses stops the run. */
export async function runTurns(
  parts: SuiteRunParts,
  written: EvalCase,
  thread: { readonly threadId: string; readonly values: CaseContextValues },
): Promise<TurnsOutcome> {
  const { threadId, values } = thread;
  // the values as validated; `execution` only where the case gives it (the built-in class has none)
  const contexts = {
    tenant: values.tenant,
    ...(written.execution === undefined ? {} : { execution: values.execution }),
  };
  let spentUsd = 0;
  let last: ExecutionOutput | undefined;
  for (const [index, turn] of written.turns.entries()) {
    if (last?.status === ExecutionStatus.Paused) {
      const message = `turn ${String(index)} paused: the turns after it cannot run`;
      return { kind: "failed", error: { code: "execution.paused", message }, spentUsd };
    }
    try {
      last = await executeUnchecked(parts.app, parts.start.component, turn.input, {
        threadId,
        ...contexts,
        record: index === written.turns.length - 1, // the last turn's trajectory (#397 PR 2)
      });
    } catch (error) {
      return { kind: "failed", error: errorOf(error), spentUsd };
    }
    spentUsd += last.spend.totalUsd;
  }
  if (last === undefined) throw new Error(`case "${written.name}" has no turns`);
  return { kind: "ended", last, spentUsd };
}
