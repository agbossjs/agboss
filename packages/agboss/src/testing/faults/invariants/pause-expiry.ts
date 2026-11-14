import { PauseResolution } from "../../../infrastructure/pause-record.js";
import { ExecutionHistoryStatus } from "../../../infrastructure/execution-history.repository.js";
import type { FaultRun } from "../facts.js";
import { FAULT_EXPIRES_IN } from "../fixture/pause.workflow.js";
import { OperationPhase } from "../operation-history.js";
import { StoreHoldPoint } from "../store-points.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * The invariants of a pause's deadline (#941), read from the store history, the kept records and
 * what the scenario sampled:
 * - `one-expiry-decision`: a pause is closed by one compare-and-set — across the closers (answer,
 *   expiry, cancel) at most one answered "changed", whichever pods raced or woke from a freeze;
 * - `no-paused-root-with-closed-pause`: no sampled root is `paused` beside a pause that is closed;
 * - `no-answer-after-deadline`: an answer of an expiring pause is dated before its deadline.
 */

/** The closers of a pause: its three ways out of `Pending` that a pod's store answers. */
const CLOSERS: readonly StoreHoldPoint[] = [
  StoreHoldPoint.PauseResolve,
  StoreHoldPoint.PauseExpire,
  StoreHoldPoint.PauseCancel,
];

/** Whether a closer's answer said the pause changed. */
const isChanged = (output: unknown): boolean =>
  typeof output === "object" && output !== null && Reflect.get(output, "isChanged") === true;

/** The role of the expiring workflow's pause: only its pauses carry a deadline's invariants. */
const EXPIRING_ROLE = "fault-expiring-question";

/** Every pause closed by more than one closer, with the pods that did. */
function closedTwiceViolations(run: FaultRun): FaultViolation[] {
  const expiring = new Set(
    run.records.flatMap((record) =>
      record.pauses.filter((pause) => pause.role === EXPIRING_ROLE).map((pause) => pause.pauseId),
    ),
  );
  const byPause = new Map<string, string[]>();
  for (const event of run.history.events) {
    const isCloser = CLOSERS.includes(event.operation);
    if (event.phase !== OperationPhase.Complete || !isCloser || event.key === undefined) continue;
    if (!expiring.has(event.key)) continue;
    if (event.error !== undefined || !isChanged(event.output)) continue;
    byPause.set(event.key, [
      ...(byPause.get(event.key) ?? []),
      `${event.process}'s ${event.operation}`,
    ]);
  }
  return [...byPause].flatMap(([pause, closers]) =>
    closers.length < 2
      ? []
      : [
          violation(
            FaultInvariant.OneExpiryDecision,
            `pause ${pause.slice(0, 8)}… was closed ${String(closers.length)} times: ${closers.join(", ")}`,
          ),
        ],
  );
}

/** A root record's status as the pod read it (text). */
const PAUSED: string = ExecutionHistoryStatus.Paused;

/** Every sampled root that was `paused` with a closed pause. */
function pausedRootViolations(run: FaultRun): FaultViolation[] {
  return (run.samples ?? []).flatMap((sample) => {
    const closed = sample.pauseStatuses.some((status) => status !== "pending");
    return sample.rootStatus === PAUSED && closed
      ? [
          violation(
            FaultInvariant.NoPausedRootWithClosedPause,
            `root ${sample.rootExecutionId} was paused with a closed pause (${sample.note})`,
          ),
        ]
      : [];
  });
}

/** Every answer of an expiring pause dated at or after its deadline. */
function lateAnswerViolations(run: FaultRun): FaultViolation[] {
  return run.records.flatMap((record) =>
    record.pauses.flatMap((pause) => {
      const isReply = pause.resolution === PauseResolution.Replied;
      if (!isReply || pause.role !== EXPIRING_ROLE || pause.resolvedAt === undefined) return [];
      const deadline = Date.parse(pause.askedAt) + FAULT_EXPIRES_IN;
      return Date.parse(pause.resolvedAt) < deadline
        ? []
        : [
            violation(
              FaultInvariant.NoAnswerAfterDeadline,
              `an answer of ${record.executionId}'s expiring pause was recorded at ${pause.resolvedAt}, its deadline ${new Date(deadline).toISOString()}`,
            ),
          ];
    }),
  );
}

/** Every violation of the pause deadline's invariants in `run`. */
export const pauseExpiryViolations = (run: FaultRun): FaultViolation[] => [
  ...closedTwiceViolations(run),
  ...pausedRootViolations(run),
  ...lateAnswerViolations(run),
];
