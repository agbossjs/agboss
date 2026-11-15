import { pauseSeamApproval, type ToolCallApproval } from "../../graph/agent-loop/index.js";
import type { GraphDeps } from "../../graph/deps.js";

/**
 * The approval of an agent's tool calls through the pause seam (#267): what the loop asks its
 * channels with — the stores, the notices, the application's clock and log (a working calendar that
 * fails is logged, #944). None without a pause seam (the loop on its own).
 */
export function seamApprovalOf(deps: GraphDeps<string>): ToolCallApproval | undefined {
  if (deps.pause === undefined) return undefined;
  return pauseSeamApproval({
    channelOf: deps.channelOf,
    pauses: deps.pause.pauses,
    answers: deps.pause.answers,
    notices: deps.pause.notices,
    log: deps.log,
    observer: deps.observer,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  });
}
