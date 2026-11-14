import { ResumeReason } from "../core/observability.js";
import type { TreeResume } from "../run/resume-map.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { observedPass } from "./observed-pass.js";
import { markTaken } from "./tree-resume.js";
import type {
  AnsweredPass,
  HeldPass,
  PlannedPass,
  TreeCall,
  TreeMoveParts,
  TreeState,
} from "./tree-move-types.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";

/** What the passes of a drain call back on: the next recorded answers, and the announcement. */
export interface DrainSteps {
  nextPass(
    state: TreeState,
    call: TreeCall,
    passed?: ReadonlySet<string>,
  ): Promise<AnsweredPass | undefined>;
  announce(reason: ResumeReason, resume: TreeResume | undefined, state: TreeState): Promise<void>;
}

/**
 * The passes of a drain (Q58): each pass, the answers it took marked `Taken`, a cancel found at rest,
 * and the next answers, until the tree finishes or rests with none left — its result.
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
  const passed = new Set<string>();
  do {
    result = await observedPass(parts, state, call, run.held, planned.pass);
    if (planned.resume !== undefined) {
      await markTaken(parts.deps, planned.resume);
      for (const pauseId of planned.resume.pauseIds) passed.add(pauseId);
    }
    await requests.endIfCancelledAtRest(parts, state, { result, ...run.held });
    const isPaused = result.status === ExecutionStatus.Paused;
    planned = isPaused ? await steps.nextPass(state, call, passed) : undefined;
    if (planned !== undefined) await steps.announce(ResumeReason.Answered, planned.resume, state);
  } while (planned !== undefined);
  return result;
}
