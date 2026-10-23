import type { AppDeps } from "../../app/app-deps.js";
import { nameOf } from "../../components/name-of.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import { finishLine, startLine } from "../../flow/runtime/history.js";
import { executionVersions } from "../../run/versions.js";
import type { NewTern } from "../../terns/index.js";
import type { EvalPastTurn } from "../suite/cases.js";

/**
 * A case's `history` (#396 PR 2, S2 Q4): its past turns written into the case's thread without
 * running — each as a finished turn of the workflow (`start <name>: <input>` / `finish <name>:
 * <output>`), no model call, no cost — so the first turn's memory (and its compaction, which runs
 * before it reads the thread) sees them as it would see real ones. Each is kept `written` (#396
 * S6): a turn of its thread, never a run `agboss eval score` scores or `agboss golden add` saves.
 */

/** The thread a case's turns run on, in its tenant. */
export interface CaseThread {
  readonly tenantId: string;
  readonly threadId: string;
}

function ternOf(deps: AppDeps, thread: CaseThread, past: EvalPastTurn): NewTern {
  const versions = executionVersions(deps);
  return {
    runId: null,
    threadId: thread.threadId,
    tenantId: thread.tenantId,
    bundle: deps.config.name,
    task: startLine(nameOf(past.start), past.input),
    replyWith: finishLine(nameOf(past.finish), past.output),
    status: ExecutionRecordStatus.Written,
    stopReason: "",
    route: [],
    steps: [],
    costUsd: 0,
    promptVersion: versions.promptVersion,
    modelVersion: versions.modelVersion,
    replayOf: null,
    configVersion: versions.configVersion,
    configHash: versions.configHash,
  };
}

/** Creates the case's thread with its past turns, oldest first; nothing for a case without any. */
export async function writeCaseHistory(
  deps: AppDeps,
  thread: CaseThread,
  history: readonly EvalPastTurn[],
): Promise<void> {
  if (history.length === 0) return;
  const { tenantId, threadId } = thread;
  await deps.terns.createThread({ workflow: deps.config.name, tenantId, threadId });
  for (const past of history) await deps.terns.append(ternOf(deps, thread, past));
}
