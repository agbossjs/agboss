import type { ExecutionHistoryRecord } from "agboss";
import type { EvalCaseReport, EvalRunReport, EvalRunResult } from "agboss/eval";
import type { EvalCaseDraft, OpenedExecutionHistory } from "agboss/internal";
import { recordDraftOf } from "../../cli/generate-eval-case.js";
import { caseTenantIdOf } from "../../scaffold/eval-case-tenant.js";
import type { FileToWrite } from "../../scaffold/write.js";

/**
 * The draft of "save as golden case" (#397 PR 5b): the run's own execution — the kept record with
 * the run's execution id, on the run's thread, of the tenant its case is written for (when the
 * suite's file says) — drafted like `agboss generate eval-case` drafts one. Refusals are worded for
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

/** What the draft is made from. */
export interface GoldenDraftSource {
  readonly history: OpenedExecutionHistory["history"];
  readonly suite: string;
  readonly file: FileToWrite;
}

/** The one kept record of the run, or why there is none. */
async function runRecordOf(
  source: GoldenDraftSource,
  { found, result }: FormRun,
  executionId: string,
): Promise<ExecutionHistoryRecord> {
  const tenantId = caseTenantIdOf(source.file, source.suite, found.name);
  const records = (await source.history.findAllByExecutionId(executionId)).filter(
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
    `the execution ${executionId} of this run is kept for several tenants (${records.map((each) => each.tenantId).join(", ")}) and the case ${found.name} does not name its tenant in ${source.file.path}: write its tenant: { tenantId } there, then reload and save again`,
  );
}

/** The new case `name`, from the run's own execution. */
export async function goldenDraftOf(
  source: GoldenDraftSource,
  run: FormRun,
  executionId: string,
  name: string,
): Promise<EvalCaseDraft> {
  if (run.result.executionId !== executionId)
    throw new GoldenRefusal(
      400,
      `the form names run ${run.found.name}#${String(run.result.run)}, but its execution is ${run.result.executionId ?? "none"}, not ${executionId}`,
    );
  return recordDraftOf(source.history, name, await runRecordOf(source, run, executionId));
}
