import type { PausedRun } from "./paused-runs.js";
import { continueAgent, type InterruptedRun } from "../run/continue-agent.js";
import { resumeAgent } from "../run/resume-agent.js";
import type { TreeResume } from "../run/resume-map.js";
import { runOptionsOf } from "./live-runs.js";
import type { TreeCall, TreeMoveParts, TreePass } from "./tree-moves.js";
import { treeResumeNow } from "./tree-resume.js";

/** How recovery continues an interrupted tree: the pass, and the answers it takes (if any). */
export interface RecoveryPass {
  readonly pass: TreePass;
  readonly resume?: TreeResume;
}

/**
 * The pass of an interrupted tree whose lease recovery holds (#265 S30): its resolved pauses first —
 * the decisions resumes recorded before the tree stopped (#267) — else from its last checkpoint.
 * `undefined` when its record is no longer `running` (it ended between the listing and the lease).
 */
export async function recoveryPassOf(
  parts: Pick<TreeMoveParts, "deps" | "paused">,
  interrupted: InterruptedRun,
  call: TreeCall,
): Promise<RecoveryPass | undefined> {
  const { deps, paused } = parts;
  const [record] = await deps.terns.byIds([interrupted.ternId]);
  if (record?.status !== "running") return undefined;
  const stored = await paused.find(interrupted);
  const resume = await treeResumeNow(deps, interrupted);
  if (resume !== undefined && stored?.run.runId === interrupted.runId) {
    return { resume, pass: resumePassOf(stored, resume, call) };
  }
  return {
    pass: (moving, signal) => continueAgent(interrupted, moving, runOptionsOf(call, signal)),
  };
}

/** The pass that continues a paused tree with the answers of its pauses. */
export const resumePassOf =
  (stored: PausedRun, resume: TreeResume, call: TreeCall): TreePass =>
  (moving, signal) =>
    resumeAgent(stored.run, resume, moving, runOptionsOf(call, signal));

/** How many calls of this instance move each root now (a count: two resumes may wait at once). */
export class RootCalls {
  readonly #calls = new Map<string, number>();

  has(rootExecutionId: string): boolean {
    return this.#calls.has(rootExecutionId);
  }

  /** Counts one more call; the returned function counts it out. */
  enter(rootExecutionId: string): () => void {
    this.#calls.set(rootExecutionId, (this.#calls.get(rootExecutionId) ?? 0) + 1);
    return () => {
      const left = (this.#calls.get(rootExecutionId) ?? 1) - 1;
      if (left === 0) this.#calls.delete(rootExecutionId);
      else this.#calls.set(rootExecutionId, left);
    };
  }
}
