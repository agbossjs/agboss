import { ApplicationStoppingError } from "../app/application-stopping.js";
import type { BuiltApp } from "../app/create-app.js";
import type { CloseOptions } from "../app/types.js";
import { stopComponents } from "../components/container/lifecycle.js";
import { startRecoverySweep, type RecoverySweep } from "../infrastructure/recovery.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { AssembledApplication } from "./assemble.js";
import type { Clock } from "../infrastructure/clock.js";
import { waitOf } from "../infrastructure/clock-timeout.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { StepCapacity } from "../app/step-slots.js";
import type { StepsAtStop } from "./instance-steps.js";

import { DEFAULT_IDEMPOTENCY_RETENTION } from "../mesh/mesh-defaults.js";
/**
 * The graceful stop of an application instance (#261, #265 S30 / S51): no new executions anywhere,
 * its own recovery sweep stopped, `onStop` once, the running executions awaited up to the shutdown
 * timeout minus its grace (#367 S3, `shutdownGraceOf`) — then interrupted: each stops without
 * failing and stays `running`, so another instance continues it — then, during the grace, the step
 * bodies still running (LangGraph's pass rejects before the bodies that ignore its signal return)
 * awaited, and only then `onDestroy`; a tree's lease waits for its own bodies the same way, so the
 * instance ends within its shutdown timeout. A later `close({ timeout })` with a shorter timeout
 * interrupts sooner and ends sooner (`close({ timeout: 0 })`: stops waiting for the bodies at once).
 */

/** The most a stop keeps for the interrupted step bodies (#367 S3). */
const MAX_SHUTDOWN_GRACE: Milliseconds = seconds(5);

/**
 * The part of a shutdown timeout kept for the step bodies its interrupted executions left running
 * (#367 S3): `min(seconds(5), 20 % of timeout)` — `seconds(25)` → `seconds(5)`, `seconds(10)` →
 * `seconds(2)`; the executions are interrupted at `timeout − grace`.
 */
export const shutdownGraceOf = (timeout: Milliseconds): Milliseconds =>
  waitOf(Math.min(MAX_SHUTDOWN_GRACE, Math.floor(timeout / 5)));

/** What the stop of one instance works on. */
export interface GracefulStopParts {
  readonly workflows: readonly BuiltApp[];
  /** Every component the container created (their hooks). */
  readonly created: readonly unknown[];
  readonly sweep: RecoverySweep;
  readonly clock: Clock;
  /** Aborted when the timeout passes: the sweep's recoveries stop with the rest. */
  readonly interruption: AbortController;
  /** `@Application({ shutdownTimeout })` or the default. */
  readonly shutdownTimeout: Milliseconds;
  /** The instance's running step bodies at its stop (#367): the stop's end, the wait for them. */
  readonly steps: StepsAtStop;
}

export interface GracefulStop {
  close(options?: CloseOptions): Promise<void>;
  /** Whether `close()` was called: from then on the instance is stopping (#300 liveness). */
  isStopping(): boolean;
  /** Resolves when the stop has finished (createApp removes its signal listeners then). */
  readonly closed: Promise<void>;
}

const interruptionOf = (timeout: Milliseconds): ApplicationStoppingError =>
  new ApplicationStoppingError(
    `the app is stopping and its shutdown timeout (${String(timeout)} ms) is ending: the execution is interrupted — it stays running and another instance continues it`,
  );

/**
 * Until the sweep and the executions ended, then the bodies their passes left running (#367) up to
 * the stop's end — what comes before any `onDestroy`; a body still running then is logged.
 */
async function executionsEnded(
  parts: GracefulStopParts,
  swept: Promise<void>,
  ended: AbortController,
): Promise<void> {
  await Promise.all([swept, ...parts.workflows.map((workflow) => workflow.settled())]);
  ended.abort();
  await parts.steps.settled();
}

/**
 * Arms the interruption of one `close({ timeout })`: the executions are interrupted a grace before
 * its end (#367 S3) — unless they ended (`ended`) or an earlier `close` interrupted them already.
 */
function interrupterOf(
  parts: GracefulStopParts,
  ended: AbortSignal,
): (timeout: Milliseconds) => void {
  const interrupt = (timeout: Milliseconds): void => {
    if (ended.aborted || parts.interruption.signal.aborted) return;
    const reason = interruptionOf(timeout);
    parts.interruption.abort(reason);
    parts.workflows.forEach((workflow) => {
      workflow.interrupt(reason);
    });
  };
  return (timeout) => {
    const until = waitOf(timeout - shutdownGraceOf(timeout));
    if (until <= 0) {
      interrupt(timeout);
      return;
    }
    void parts.clock.sleep(until, ended).then(() => {
      interrupt(timeout);
    });
  };
}

export function gracefulStopOf(parts: GracefulStopParts): GracefulStop {
  const { workflows } = parts;
  /** Aborted at the stop's end: the interrupted step bodies are awaited until then. */
  const deadline = parts.steps;
  /** Aborted once the executions ended: the timers waiting to interrupt them are not needed. */
  const ended = new AbortController();
  let closing: Promise<void> | undefined;
  let markClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const arm = interrupterOf(parts, ended.signal);
  const stop = async (): Promise<void> => {
    for (const workflow of workflows) workflow.refuse(deadline.signal);
    const swept = parts.sweep.stop();
    try {
      await stopComponents(parts.created, () => executionsEnded(parts, swept, ended));
    } finally {
      ended.abort();
      deadline.release();
      for (const workflow of workflows) await workflow.app.close();
      markClosed();
    }
  };
  return {
    closed,
    isStopping: () => closing !== undefined,
    close: (options = {}) => {
      const timeout = options.timeout ?? parts.shutdownTimeout;
      deadline.endBy(timeout);
      closing ??= stop();
      arm(timeout);
      return closing;
    },
  };
}

/** What the instance's stop and recovery work with besides its workflows. */
export interface InstanceParts {
  readonly created: readonly unknown[];
  readonly infrastructure: Infrastructure;
  readonly log: FrameworkLog;
  /** The instance's step slots (#332): its sweep recovers only into free ones. */
  readonly stepSlots?: StepCapacity | undefined;
  /** The instance's running step bodies at its stop (#367). */
  readonly stepsAtStop: StepsAtStop;
}

/** The instance's recovery sweep and graceful stop. */
export interface InstanceStop {
  readonly stop: GracefulStop;
  readonly sweep: RecoverySweep;
}

/** The instance's recovery sweep, started now (`onStart` is done, #265 S30), and its graceful stop. */
export function stopOf(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  parts: InstanceParts,
): InstanceStop {
  const { clock } = parts.infrastructure;
  const interruption = new AbortController();
  const sweep = startRecoverySweep({
    records: parts.infrastructure.records,
    workflows: new Map(workflows.map((workflow) => [workflow.deps.config.name, workflow.recover])),
    clock,
    log: parts.log,
    signal: interruption.signal,
    pauses: parts.infrastructure.pausedExecutions,
    pauseRecordRetention: assembled.pauseRecordRetention,
    meshRequests: parts.infrastructure.meshRequests,
    idempotencyRetention: assembled.mesh?.idempotencyRetention ?? DEFAULT_IDEMPOTENCY_RETENTION,
    capacity: parts.stepSlots,
  });
  const { shutdownTimeout } = assembled;
  const stop = gracefulStopOf({
    workflows,
    created: parts.created,
    sweep,
    clock,
    interruption,
    shutdownTimeout,
    steps: parts.stepsAtStop,
  });
  return { stop, sweep };
}
