import {
  checkResume,
  IncompatibleResumeError,
  type IncompatibleResumePolicy,
  type ResumeVersions,
} from "../run/resume-guard.js";
import type { Tern } from "../terns/index.js";
import type { AppDeps } from "./app-deps.js";
import { withTreeOrigin } from "./tree-origin.js";
import type { TreeMoves } from "./tree-moves.js";

/**
 * Continues one `running` root of this workflow (#265 S30) when its lease is free; `signal` stops
 * it like a stop of the app. `IncompatibleResumeError` when this instance may not continue it.
 */
export type RecoverRoot = (record: Tern, signal: AbortSignal) => Promise<void>;

/** What continuing a root needs from its workflow's app. */
export interface RecoverRootParts {
  readonly deps: AppDeps;
  readonly moves: TreeMoves;
  /** The workflow version and config hash this instance runs. */
  readonly current: ResumeVersions;
  readonly policy: IncompatibleResumePolicy | undefined;
}

/**
 * The compatibility check of `app.resume` applies (#261): a root started under another config is
 * continued only when the workflow's `onIncompatibleResume` says "resume" — otherwise it is left
 * to an instance of a compatible version (a rolling deploy) — unless it has a cancel request (#360)
 * or its automatic undo was under way (#340 PR 4), which end it on any instance. The owner is the
 * thread's.
 */
export const recoverRootOf =
  ({ deps, moves, current, policy }: RecoverRootParts): RecoverRoot =>
  async (record, signal) => {
    const { runId, threadId, tenantId } = record;
    if (runId === null) return;
    const startedVersion = record.configVersion ?? deps.config.version;
    const facts = { runId, threadId, tenantId, ternId: record.id, startedVersion };
    const interrupted = await withTreeOrigin(deps, facts);
    // a cancel requested, or an undo begun, while its holder was down: ended at once, whatever
    // config it started on (#360, #340 PR 4)
    if (await moves.endIfEnding(interrupted)) return;
    const started = {
      workflowVersion: record.configVersion ?? "",
      configHash: record.configHash ?? "",
    };
    checkResume({ threadId, executionId: runId, paused: started, current }, policy);
    const thread = await deps.terns.threadOwner(deps.config.name, tenantId, threadId);
    const ownerId = thread?.owner;
    await moves.recovered(interrupted, { signal, ownerId });
  };

/** A recovery problem, for the log: at risk (left to another instance) or broken. */
export interface RecoveryProblem {
  readonly code: string;
  readonly text: string;
  readonly isBroken: boolean;
  readonly executionId?: string;
  readonly tenantId?: string;
}

/** The problem of one record's recovery. */
export const problemOf = (record: Tern, error: unknown): RecoveryProblem => {
  const ids = { executionId: record.runId ?? record.id, tenantId: record.tenantId };
  return error instanceof IncompatibleResumeError
    ? {
        code: "recovery.incompatible",
        text: `execution ${ids.executionId} is left to an instance of a compatible version: ${error.message}`,
        isBroken: false,
        ...ids,
      }
    : {
        code: "recovery.failed",
        text: `recovery of execution ${ids.executionId} failed: ${error instanceof Error ? error.message : String(error)}`,
        isBroken: true,
        ...ids,
      };
};
