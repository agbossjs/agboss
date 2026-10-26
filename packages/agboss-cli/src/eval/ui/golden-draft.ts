import type { ExecutionHistoryRecord } from "@agboss/core";
import type { EvalCaseReport, EvalRunReport, EvalRunResult } from "@agboss/core/eval";
import type { EvalCaseDraft, OpenedExecutionHistory } from "@agboss/core/internal";
import { recordDraftOf } from "../../cli/generate-eval-case.js";

/**
 * The draft of "save as golden case" (#397 PR 5b): the run's own execution — the kept record with
 * the run's execution id, on the run's thread, of the run's tenant (`EvalRunResult.tenantId`,
 * schemaVersion 4) — drafted like `agboss generate eval-case` drafts one. Refusals are worded for
 * the page that posted the form, never with the CLI's options.
 */

/** Why the case cannot be drafted, as the answer's status and text. */
export class GoldenRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The run a form names (`<case>#<n>`), when the report has it. */
export interface FormRun {
  readonly caseIndex: number;
  readonly found: EvalCaseReport;
  readonly result: EvalRunResult;
}

export function formRunOf(report: EvalRunReport, run: string): FormRun | undefined {
  const at = run.lastIndexOf("#");
  const caseIndex = report.cases.findIndex((found) => found.name === run.slice(0, at));
  const found = report.cases[caseIndex];
  const result = found?.runResults.find((each) => String(each.run) === run.slice(at + 1));
  return found === undefined || result === undefined ? undefined : { caseIndex, found, result };
}

/** The one kept record of the run, or why there is none. */
async function runRecordOf(
  history: OpenedExecutionHistory["history"],
  { result }: FormRun,
  executionId: string,
): Promise<ExecutionHistoryRecord> {
  const { tenantId } = result;
  const records = (await history.findAllByExecutionId(executionId)).filter(
    (record) =>
      record.threadId === result.threadId &&
      (tenantId === undefined || record.tenantId === tenantId),
  );
  const [record] = records;
  if (record !== undefined && records.length === 1) return record;
  const whose = tenantId === undefined ? "" : ` of tenant ${tenantId}`;
  if (record === undefined)
    throw new GoldenRefusal(
      404,
      `the execution ${executionId}${whose} on this run's thread is not in the application's history: it was not kept, or its retention removed it`,
    );
  throw new GoldenRefusal(
    409,
    `the execution ${executionId} of this run is kept for several tenants (${records.map((each) => each.tenantId).join(", ")}), and this run was recorded before runs carried their tenant: run the suite again and save from the new run`,
  );
}

/** The new case `name`, from the run's own execution. */
export async function goldenDraftOf(
  history: OpenedExecutionHistory["history"],
  run: FormRun,
  executionId: string,
  name: string,
): Promise<EvalCaseDraft> {
  if (run.result.executionId !== executionId)
    throw new GoldenRefusal(
      400,
      `the form names run ${run.found.name}#${String(run.result.run)}, but its execution is ${run.result.executionId ?? "none"}, not ${executionId}`,
    );
  return recordDraftOf(history, name, await runRecordOf(history, run, executionId));
}
