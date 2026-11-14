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

/** What the passes of a drain call back on: the announcement. */
export interface DrainSteps {
  announce(reason: ResumeReason, resume: TreeResume | undefined, state: TreeState): Promise<void>;
}

/**
 * The passes of a drain (Q58): each pass, the answers it took marked `Taken`, a cancel found at rest,
 * and the next answers or the due pauses' expiry (#941, I6), until the tree finishes or rests with none left — its result.
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
    if (planned.resume !== undefined) {
      await markTaken(parts.deps, planned.resume);
      for (const pauseId of planned.resume.pauseIds) track.passed.add(pauseId);
    }
    await requests.endIfCancelledAtRest(parts, state, { result, ...run.held });
    const isPaused = result.status === ExecutionStatus.Paused;
    // a pass never rests on a due pause (#941, I6): the holder expires it before it lets go
    const next = isPaused ? await restedPassOf(parts, state, call, track) : undefined;
    planned = next?.planned;
    if (next !== undefined) await steps.announce(next.reason, next.planned.resume, state);
  } while (planned !== undefined);
  return result;
}
