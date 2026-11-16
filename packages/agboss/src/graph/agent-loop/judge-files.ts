import type { FileContent } from "../../files/file-bytes.js";
import { fileMaskOf } from "../../files/file-mask.js";
import type { FilePiece } from "../../files/file-pieces.js";
import type { UsageRecord } from "../../finops/usage.js";
import { lazyLoad } from "../../infrastructure/clock.js";
import type { AgentLoopDeps } from "./deps.js";
import { loopPoliciesOf } from "./model-pii.js";
import { loopUsage, type AgentLoopStateType } from "./state.js";

/** The files the agent's model read in the visit, as the judges are given them. */
export interface JudgedFiles {
  readonly files: readonly FileContent[];
  readonly pieces: readonly FilePiece[];
  readonly usage: readonly UsageRecord[];
}

export const EMPTY_SEEN: JudgedFiles = { files: [], pieces: [], usage: [] };

/**
 * The files the model read, in the views it read them (#899 §8): each source file it saw, read again
 * through the guarded path and pinned to the digest it had, its transcription from the execution's
 * cache. A transcription never made twice; a file that changed since is refused (`digest-mismatch`).
 */
export async function judgedFilesOf(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
): Promise<JudgedFiles> {
  const { fileRuntime: runtime } = deps;
  if (runtime === undefined || state.seen.length === 0) return EMPTY_SEEN;
  const { filePiecesOf } = await lazyLoad(import("../../files/visit-files.js"));
  const built = await filePiecesOf({
    runtime,
    files: state.seen.map((seen) => seen.source),
    tally: { count: 0, bytes: 0 },
    cache: state.fileTranscripts,
    first: 1,
    of: state.seen.length,
    pins: state.seen.map((seen) => seen.digest),
    mask: fileMaskOf(loopPoliciesOf(state, deps), state.piiTokens),
    beforeModelCall: () => {
      deps.budgets.check(state.usage, state.flowPath, loopUsage(state));
    },
  });
  return {
    files: built.viewed.map((view) => view.content),
    pieces: built.pieces,
    usage: built.usage,
  };
}
