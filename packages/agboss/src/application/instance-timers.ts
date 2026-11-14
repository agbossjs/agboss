import type { Infrastructure } from "../infrastructure/contracts.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { expiryLookOf, type ExpiringWorkflow } from "./pause-expiry-look.js";
import type { PauseNoticeHub } from "./pause-notice-hub.js";
import { startPauseTimers, type PauseTimers } from "./pause-timers.js";

/**
 * The pause timers of an application instance (#940, #941): one loop whose looks are the delivery of
 * pause notices and the expiry of the pauses whose deadline passed — started now, stopped by the
 * instance's `interruption`.
 */
export function instanceTimersOf(
  parts: {
    readonly infrastructure: Infrastructure;
    readonly log: FrameworkLog;
    readonly notices: PauseNoticeHub;
  },
  workflows: readonly ExpiringWorkflow[],
  signal: AbortSignal,
): PauseTimers {
  const { infrastructure, log, notices } = parts;
  return startPauseTimers({
    clock: infrastructure.clock,
    log,
    signal,
    looks: [
      { name: "notices", run: () => notices.look() },
      expiryLookOf(infrastructure, log, workflows, signal),
    ],
  });
}
