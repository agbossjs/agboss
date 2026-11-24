import { ResumeReason } from "../core/observability.js";
import type { TreeResume } from "../run/resume-map.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { observedPass } from "./observed-pass.js";
import { markTaken } from "./tree-resume.js";
import { restedPassOf } from "./tree-expiry.js";
import type {
  HeldPass,
  PlannedPass,
  TreeCall,
  TreeMoveParts,
  TreeState,
} from "./tree-move-types.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";
import { parkedAtRest } from "./parked-output.js";
import { markedInterruptOf } from "./interrupt-requests.js";
import { treeOf } from "./tree-ends.js";

/** What the passes of a drain call back on: the announcement. */
export interface DrainSteps {
  announce(reason: ResumeReason, resume: TreeResume | undefined, state: TreeState): Promise<void>;
}

/**
 * The passes of a drain (Q58): each pass, the answers it took marked `Taken`, a cancel found at rest,
 * and the next answers or the due pauses' expiry (#941, I6), until the tree finishes, is stopped or cancelled, or rests with none left — its result.
 */
export async function passesOf(
  parts: TreeMoveParts,
  steps: DrainSteps,
  at: { readonly state: TreeState; readonly call: TreeCall },
  run: { readonly held: HeldPass; readonly first: PlannedPass },
): Promise<ExecutionOutput> {
  const { state, call } = at;
  const requests = await lazyLoad(import("./cancel-requests.js"));
  let planned: PlannedPass | undefined = run.first;
  let result: ExecutionOutput;
  const track = { passed: new Set<string>(), tried: new Set<string>() };
  do {
    result = await observedPass(parts, state, call, run.held, planned.pass);
    // a pass a stop or a cancel ended took no answer: its pauses are closed with the tree's end
    // (`not taken`), never marked `Taken` as a pass that returned (#1341, as the throw it was)
    if (result.status === ExecutionStatus.Cancelled || result.status === ExecutionStatus.Stopped)
      return result;
    if (planned.resume !== undefined) {
      await markTaken(parts.deps, planned.resume);
      for (const pauseId of planned.resume.pauseIds) track.passed.add(pauseId);
    }
    // a cancel found at rest ends the tree: the passes stop with its cancelled output
    const cancelled = await requests.endIfCancelledAtRest(parts, state, { result, ...run.held });
    if (cancelled !== undefined) return cancelled;
    // a tree parked by a pause that a cancel or a stop met meanwhile (its lease row's mark: a local
    // cancel writes no key) is ended here, not left parked with its request unanswered
    if (
      result.status === ExecutionStatus.Paused &&
      result.isExternallyPaused &&
      (await markedInterruptOf(parts.leases, treeOf(state))) !== undefined
    ) {
      // the unwind runs on a lease taken anew — at a token above the pause's fence, which the
      // parked holder's own token is under: the stale step stays fenced, the undo is not (#1341c)
      await run.held.lease.release();
      const ended = await requests.endHeld(parts, state);
      if (ended instanceof Error) throw ended;
      if (ended !== undefined) return ended;
    }
    // frozen from outside (#1341c): a parked tree, or a business rest the operator froze — nothing
    // takes an answer or an expiry before `app.unpause`
    const parked =
      result.status === ExecutionStatus.Paused
        ? await parkedAtRest(parts, state, result, run.held.lease)
        : undefined;
    if (parked !== undefined) return parked;
    const isPaused = result.status === ExecutionStatus.Paused;
    // a pass never rests on a due pause (#941, I6): the holder expires it before it lets go
    const next = isPaused ? await restedPassOf(parts, state, call, track) : undefined;
    planned = next?.planned;
    if (next !== undefined) await steps.announce(next.reason, next.planned.resume, state);
  } while (planned !== undefined);
  return result;
}
