import { copyOf } from "../infrastructure/instants.js";
import type { PauseChange } from "../flow/observers/pause-changes.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import type { AppDeps } from "./app-deps.js";
import { ownDepsOf } from "./own-deps.js";

/**
 * The events of a pause an operator changed (`onPauseTimeoutChanged`, `onPauseReassigned`, #1307):
 * told once, by the call whose write won, to the observers of the workflow whose step asked — masked
 * by its policies. They name where the pause waits, never its id (the right to answer it).
 */

/** The workflow's observers; none when it is no longer in this application. */
function observerOf(deps: AppDeps, pause: PauseRecord): ExecutionObserverManager | undefined {
  try {
    return ownDepsOf(deps, pause.workflow).observer;
  } catch {
    return undefined;
  }
}

/** What both events carry: where the pause waits (a pause nobody is asked about has no channel). */
function pauseChangeOf(pause: PauseRecord): PauseChange {
  return {
    tenantId: pause.tenantId,
    executionId: pause.rootExecutionId,
    threadId: pause.threadId,
    workflow: pause.workflow,
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
  };
}

/** Tells the workflow's observers; what they throw is their manager's to report, never the call's. */
async function toldPauseChange(
  deps: AppDeps,
  pause: PauseRecord,
  tell: (observer: ExecutionObserverManager) => Promise<void>,
): Promise<void> {
  const observer = observerOf(deps, pause);
  if (observer !== undefined) await tell(observer);
}

/** A timeout change that won: both deadlines (absent: none), copied: what a hook gets is never the record's own instance. */
export function toldTimeoutChanged(
  deps: AppDeps,
  pause: PauseRecord,
  deadlines: {
    readonly previousExpiresAt?: Date | undefined;
    readonly expiresAt?: Date | undefined;
  },
): Promise<void> {
  const { previousExpiresAt, expiresAt } = deadlines;
  return toldPauseChange(deps, pause, (observer) =>
    observer.onPauseTimeoutChanged({
      ...pauseChangeOf(pause),
      ...(previousExpiresAt === undefined
        ? {}
        : { previousExpiresAt: copyOf(previousExpiresAt) }),
      ...(expiresAt === undefined ? {} : { expiresAt: copyOf(expiresAt) }),
    }),
  );
}

/** A reassignment that won: the channel the replacement is asked on, and the deadline it keeps. */
export function toldReassigned(
  deps: AppDeps,
  pause: PauseRecord,
  replacement: PauseRecord,
): Promise<void> {
  return toldPauseChange(deps, pause, (observer) =>
    observer.onPauseReassigned({
      ...pauseChangeOf(replacement),
      previousTarget: pause.target,
      ...(pause.channel === undefined ? {} : { previousChannel: pause.channel }),
      ...(replacement.expiresAt === undefined
        ? {}
        : { expiresAt: copyOf(replacement.expiresAt) }),
    }),
  );
}
