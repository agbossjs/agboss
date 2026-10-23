import {
  evalCaseDraftOf,
  observedExecutionOf,
  openExecutionHistory,
  type EvalCaseDraft,
  type OpenedExecutionHistory,
} from "agboss/internal";
import type { ExecutionHistoryRecord } from "agboss";
import { planEvalCase, type EvalCasePlan } from "../scaffold/generate-eval-case.js";
import { loadCliApplication } from "./cli-application.js";
import { textOption, type CommandContext } from "./context.js";
import { envOption } from "./environment.js";
import { CliError, usageError } from "./errors.js";

/**
 * `agboss generate eval-case <name> [--suite <name>] --from-execution <executionId> [--tenant <id>]
 * [--env <name>]` (#396 PR 8): a kept execution (`executionRecordRetention`, #401) read from the
 * application's history — its stores opened, nothing run — and drafted into a case: its start's
 * input as the turn, its contexts, its thread's earlier finished turns as the history, the tool
 * calls it ran as the required calls; then written into the suite's file.
 */

const COMMAND = "generate";

/** The one kept record of `--from-execution` (of `--tenant`, when two tenants have the id). */
function onlyRecord(
  records: readonly ExecutionHistoryRecord[],
  executionId: string,
): ExecutionHistoryRecord {
  const [record] = records;
  if (record !== undefined && records.length === 1) return record;
  if (record === undefined)
    throw new CliError(
      "project",
      "records.not-found",
      `no kept execution ${executionId}: it is not in the application's history (or its retention removed it)`,
    );
  const tenants = records.map((found) => found.tenantId).join(", ");
  throw usageError(
    COMMAND,
    "records.ambiguous-execution",
    `execution ${executionId} is kept for several tenants (${tenants}): name one with --tenant <id>`,
  );
}

/** The kept records of an execution id: one tenant's, or every tenant's. */
async function recordsOf(
  history: OpenedExecutionHistory["history"],
  executionId: string,
  tenant: string | undefined,
): Promise<readonly ExecutionHistoryRecord[]> {
  if (tenant === undefined) return history.findAllByExecutionId(executionId);
  const record = await history.findByTenantIdAndExecutionId(tenant, executionId);
  return record === undefined ? [] : [record];
}

/**
 * The case `name` drafted from a kept execution: its record (of `tenant`, when given) and its
 * thread's earlier turns — for `agboss generate eval-case` and `agboss eval ui`'s "save as golden
 * case" (#397 PR 5) alike. `records.not-found` / `records.ambiguous-execution` when it is not one.
 */
export async function keptDraftOf(
  history: OpenedExecutionHistory["history"],
  name: string,
  executionId: string,
  tenant?: string,
): Promise<EvalCaseDraft> {
  const record = onlyRecord(await recordsOf(history, executionId, tenant), executionId);
  const thread = await history.findAllByTenantIdAndThreadId(record.tenantId, record.threadId);
  return evalCaseDraftOf(name, observedExecutionOf(record, thread));
}

/** The case `name` drafted from the kept execution the options name. */
async function draftOf(context: CommandContext, name: string): Promise<EvalCaseDraft> {
  const executionId = textOption(context.values, "from-execution");
  if (executionId === undefined)
    throw usageError(
      COMMAND,
      "usage.missing-option",
      "eval-case needs --from-execution <executionId>",
    );
  const tenant = textOption(context.values, "tenant");
  const { application } = await loadCliApplication(context);
  const opened = await openExecutionHistory(application, {
    env: envOption(context),
    processEnv: context.io.env,
  });
  try {
    if (!opened.isKept)
      throw new CliError(
        "project",
        "records.not-kept",
        `${opened.application} keeps no execution records: set @Application({ executionRecordRetention }) to keep them`,
      );
    return await keptDraftOf(opened.history, name, executionId, tenant);
  } finally {
    await opened.close();
  }
}

/** The plan of `agboss generate eval-case`. */
export async function evalCasePlanOf(context: CommandContext, name: string): Promise<EvalCasePlan> {
  const draft = await draftOf(context, name);
  return planEvalCase(context.io.cwd, draft, {
    application: textOption(context.values, "application"),
    suite: textOption(context.values, "suite"),
  });
}
