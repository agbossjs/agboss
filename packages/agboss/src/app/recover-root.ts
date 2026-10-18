import {
  checkResume,
  type IncompatibleResumePolicy,
  type ResumeVersions,
} from "../run/resume-guard.js";
import type { Tern } from "../terns/index.js";
import type { AppDeps } from "./app-deps.js";
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
 * to an instance of a compatible version (a rolling deploy). The owner is the thread's.
 */
export const recoverRootOf =
  ({ deps, moves, current, policy }: RecoverRootParts): RecoverRoot =>
  async (record, signal) => {
    const { runId, threadId, tenantId } = record;
    if (runId === null) return;
    const started = {
      workflowVersion: record.configVersion ?? "",
      configHash: record.configHash ?? "",
    };
    checkResume({ thread: threadId, runId, paused: started, current }, policy);
    const thread = await deps.terns.threadOwner(deps.config.name, tenantId, threadId);
    const ownerId = thread?.owner;
    const startedVersion = record.configVersion ?? deps.config.version;
    const interrupted = { runId, threadId, tenantId, ternId: record.id, startedVersion };
    await moves.recovered(interrupted, { signal, ownerId });
  };
