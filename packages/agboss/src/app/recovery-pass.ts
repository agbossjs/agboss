import type { TurnStore } from "../turns/index.js";
import type { PausedExecution } from "./paused-runs.js";
import { continueAgent, type InterruptedRun } from "../run/continue-agent.js";
import { resumeAgent } from "../run/resume-agent.js";
import { runningOutcome } from "../run/execute.js";
import type { TreeResume } from "../run/resume-map.js";
import { runOptionsOf } from "./live-runs.js";
import { ResumeReason } from "../core/observability.js";
import type {
  AnsweredPass,
  PlannedPass,
  TreeCall,
  TreeMoveParts,
  TreePass,
  TreeState,
} from "./tree-move-types.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import { readingGraphOf } from "../run/run-budgets.js";
import { waitingInterruptsOf } from "../run/waiting-pauses.js";
import { callWithLostPasses, treeResumeNow } from "./tree-resume.js";

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
  parts: Pick<TreeMoveParts, "deps" | "paused" | "auditLog">,
  interrupted: InterruptedRun,
  given: TreeCall,
): Promise<RecoveryPass | undefined> {
  const { deps, paused } = parts;
  if (await recordEndedOf(deps.turns, interrupted.turnId)()) return undefined;
  // its first pass runs again what the tree's earlier holders lost (#853)
  const call = await callWithLostPasses(parts, interrupted, given);
  const stored = await paused.find(interrupted);
  const resume = await treeResumeNow(deps, interrupted);
  if (resume !== undefined && stored?.run.runId === interrupted.runId) {
    return { resume, pass: resumePassOf(stored, resume, call) };
  }
  return {
    pass: (moving, signal) => continueAgent(interrupted, moving, runOptionsOf(call, signal)),
  };
}

/**
 * The pass of a tree a resume took the lease of and found no answer to take (#1098): when nothing
 * of it waits — no open interrupt, at any depth — and its record still runs, it was left mid-pass:
 * its holder lost the tree after a task's writes and before the checkpoint after them, the answer
 * this resume recorded among those writes. The resume holds the lease, so it continues the tree as
 * recovery would (`continueAgent`: the saved writes applied, the rest run once) and reports where
 * it got. `undefined` when the tree waits at a pause or its record ended: where it is now is read.
 */
export async function stalledPassOf(
  deps: TreeMoveParts["deps"],
  state: TreeState,
  call: TreeCall,
): Promise<RecoveryPass | undefined> {
  const record = await deps.turns.findByTenantIdAndRunId(state.tenantId, state.runId);
  if (record?.status !== ExecutionRecordStatus.Running) return undefined;
  if ((await waitingInterruptsOf(readingGraphOf(deps), state.runId)).length > 0) return undefined;
  const interrupted = { ...state, turnId: record.id };
  return {
    pass: (moving, signal) => continueAgent(interrupted, moving, runOptionsOf(call, signal)),
  };
}

/**
 * Whether a root's record no longer runs (#520): its tree ended between the sweep's listing and a
 * take of its lease — `LeaseTake.isOver` of the sweep's takes.
 */
export const recordEndedOf =
  (turns: Pick<TurnStore, "byIds">, turnId: string) => async (): Promise<boolean> =>
    (await turns.byIds([turnId]))[0]?.status !== "running";

/** The pass that continues a paused tree with the answers of its pauses. */
export const resumePassOf =
  (stored: PausedExecution, resume: TreeResume, call: TreeCall): TreePass =>
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

/** The answers recorded for the tree now and its stored rest; `undefined` when it has none (or rests no more). */
async function answeredRunOf(
  parts: Pick<TreeMoveParts, "deps" | "paused">,
  state: TreeState,
  passed?: ReadonlySet<string>,
): Promise<{ readonly resume: TreeResume; readonly stored: PausedExecution } | undefined> {
  const { deps, paused } = parts;
  const resume = await treeResumeNow(deps, state, passed);
  if (resume === undefined) return undefined;
  const stored = await paused.find(state);
  if (stored?.run.runId !== state.runId) return undefined;
  return { resume, stored };
}

/**
 * The tree has work again: its record `running` before anything moves it (#1187, #850's order) —
 * a drain that rested (its pass wrote `paused`) and goes on with an answer recorded meanwhile,
 * killed in that pass, leaves a record recovery continues, never a `paused` root beside an answer it
 * took. A compare-and-set from `paused`: its caller holds the lease.
 */
async function markedRunning(
  deps: Pick<TreeMoveParts["deps"], "turns">,
  stored: PausedExecution,
): Promise<boolean> {
  const { run } = stored;
  const outcome = runningOutcome(run.path, run.cost.totalUsd);
  return deps.turns.completeIfStatus(run.turnId, ExecutionRecordStatus.Paused, outcome);
}

/**
 * The pass that takes the tree's recorded answers now (`answeredRunOf`); `undefined` when it has
 * none. `isAfterRest`: the drain's pass after its rest — the record is marked `running` first
 * (`markedRunning`); a resume or an expiry marked it before taking the lease.
 */
export async function answeredPassOf(
  parts: TreeMoveParts,
  state: TreeState,
  call: TreeCall,
  passed?: ReadonlySet<string>,
  isAfterRest = false,
): Promise<AnsweredPass | undefined> {
  const answered = await answeredRunOf(parts, state, passed);
  if (answered === undefined) return undefined;
  if (isAfterRest) await markedRunning(parts.deps, answered.stored);
  return { resume: answered.resume, pass: resumePassOf(answered.stored, answered.resume, call) };
}

/**
 * The pass a resume holding the lease runs: the answers recorded and not yet taken; else, when its
 * holder lost the tree mid-pass after the writes that took this answer (#1098), the pass that moves
 * it on from its checkpoint; `undefined` when the tree rests or ended (where it is is read).
 */
export async function takenPassOf(
  parts: TreeMoveParts,
  state: TreeState,
  call: TreeCall,
): Promise<{ readonly reason: ResumeReason; readonly planned: PlannedPass } | undefined> {
  const answered = await answeredPassOf(parts, state, call);
  if (answered !== undefined) return { reason: ResumeReason.Answered, planned: answered };
  const stalled = await stalledPassOf(parts.deps, state, call);
  return stalled === undefined ? undefined : { reason: ResumeReason.Recovered, planned: stalled };
}
