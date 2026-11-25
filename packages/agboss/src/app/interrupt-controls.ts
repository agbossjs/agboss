import { lazyLoad } from "../infrastructure/clock.js";
import type { CancelThreadParts } from "./cancel-thread.js";
import type { TreeMoves } from "./tree-move-types.js";
import type { WorkflowApp } from "./types.js";

/**
 * The controls of an execution from outside — cancel, stop, pause, unpause —, each loaded on its
 * first call: a cancel on another instance's execution leaves it a request (#360), a stop is a
 * cancel that undoes nothing (#1341b), a pause freezes the execution where it stands and an
 * unpause continues it (#1341c).
 */
export function interruptControlsOf(
  parts: CancelThreadParts,
  moves: TreeMoves,
): Pick<WorkflowApp, "cancel" | "stop" | "pause" | "unpause"> {
  return {
    cancel: async (threadId, options = {}) =>
      (await lazyLoad(import("./cancel-thread.js"))).cancelThread(parts, threadId, options),
    stop: async (threadId, options = {}) =>
      (await lazyLoad(import("./stop-thread.js"))).stopThread(parts, threadId, options),
    pause: async (threadId, options = {}) =>
      (await lazyLoad(import("./pause-thread.js"))).pauseThread(parts, threadId, options),
    unpause: async (threadId, options = {}) =>
      (await lazyLoad(import("./unpause-thread.js"))).unpauseThread(
        { ...parts, moves },
        threadId,
        options,
      ),
  };
}
