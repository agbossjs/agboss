import { checkResume, IncompatibleResumeError } from "../run/resume-guard.js";
import type { Turn } from "../turns/index.js";
import type { RecoverRootParts } from "./recover-root.js";
import { withTreeOrigin } from "./tree-origin.js";

/**
 * Expires the due pauses of one resting root of this workflow (#941): the expiry look found a
 * pause past its deadline under it. `signal` stops it like a stop of the app. A root started under
 * another config is left to an instance of a compatible version (as a resume or a recovery is);
 * anything else — a lease not free, a tree not resting, no pause due — is the move's to decide.
 */
export type ExpireRoot = (record: Turn, signal: AbortSignal) => Promise<void>;

export const expireRootOf =
  ({ deps, moves, current, policy }: RecoverRootParts): ExpireRoot =>
  async (record, signal) => {
    const { runId, threadId, tenantId } = record;
    if (runId === null) return;
    const startedVersion = record.configVersion ?? deps.config.version;
    const started = {
      workflowVersion: record.configVersion ?? "",
      configHash: record.configHash ?? "",
    };
    try {
      checkResume({ threadId, executionId: runId, paused: started, current }, policy);
    } catch (error) {
      if (error instanceof IncompatibleResumeError) return;
      throw error;
    }
    const facts = { runId, threadId, tenantId, turnId: record.id, startedVersion };
    const interrupted = await withTreeOrigin(deps, facts);
    const owner = await deps.turns.threadOwner(deps.config.name, tenantId, threadId);
    await moves.expired(interrupted, { signal, ownerId: owner?.owner });
  };
