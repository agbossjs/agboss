import type { StepCapacity } from "../app/step-slots.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { expiryLookOf, type ExpiringWorkflow } from "./pause-expiry-look.js";
import type { PauseNoticeHub } from "./pause-notice-hub.js";
import { reminderLookOf } from "./pause-reminder-look.js";
import { startPauseTimers, type PauseTimers } from "./pause-timers.js";

/**
 * The pause timers of an application instance (#940, #941, #942): one loop whose looks are the delivery
 * of pause notices, the expiry of the pauses whose deadline passed and the reminders before it — started now, stopped by the
 * instance's `interruption`.
 */
export function instanceTimersOf(
  parts: {
    readonly infrastructure: Infrastructure;
    readonly log: FrameworkLog;
    readonly notices: PauseNoticeHub;
    /** The instance's step slots (#332): the expiries in flight are capped by them. */
    readonly stepSlots?: StepCapacity | undefined;
  },
  workflows: readonly ExpiringWorkflow[],
  signal: AbortSignal,
): PauseTimers {
  const { infrastructure, log, notices, stepSlots } = parts;
  return startPauseTimers({
    clock: infrastructure.clock,
    log,
    signal,
    looks: [
      { name: "notices", run: () => notices.look() },
      expiryLookOf(infrastructure, log, workflows, signal, stepSlots),
      reminderLookOf(
        infrastructure,
        log,
        {
          bundles: new Set(workflows.map((one) => one.deps.config.name)),
          recipientsOf: (pause) => notices.recipientsOf(pause),
          delivered: () => {
            notices.delivered();
          },
        },
        signal,
      ),
    ],
  });
}
