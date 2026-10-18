import { ApplicationStoppingError } from "../app/application-stopping.js";
import type { BuiltApp } from "../app/create-app.js";
import type { CloseOptions } from "../app/types.js";
import { stopComponents } from "../components/container/lifecycle.js";
import type { RecoverySweep } from "../infrastructure/recovery.js";
import type { Clock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";

/**
 * The graceful stop of an application instance (#261, #265 S30 / S51): no new executions anywhere,
 * its own recovery sweep stopped, `onStop` once, the running executions awaited up to the shutdown
 * timeout — then interrupted: each stops without failing, releases its lease at once in `finally`
 * and stays `running`, so another instance continues it without waiting for the lease to expire —
 * then `onDestroy`. A later `close({ timeout })` with a shorter timeout shortens the wait.
 */

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
}

export interface GracefulStop {
  close(options?: CloseOptions): Promise<void>;
  /** Resolves when the stop has finished (createApp removes its signal listeners then). */
  readonly closed: Promise<void>;
}

const interruptionOf = (timeout: Milliseconds): ApplicationStoppingError =>
  new ApplicationStoppingError(
    `the app is stopping and its shutdown timeout (${String(timeout)} ms) passed: the execution is interrupted — it stays running and another instance continues it`,
  );

export function gracefulStopOf(parts: GracefulStopParts): GracefulStop {
  const { workflows, clock } = parts;
  /** Aborted once the executions ended: the timers waiting to interrupt them are not needed. */
  const ended = new AbortController();
  let closing: Promise<void> | undefined;
  let markClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const interrupt = (timeout: Milliseconds): void => {
    if (ended.signal.aborted || parts.interruption.signal.aborted) return;
    const reason = interruptionOf(timeout);
    parts.interruption.abort(reason);
    workflows.forEach((workflow) => {
      workflow.interrupt(reason);
    });
  };
  const arm = (timeout: Milliseconds): void => {
    if (timeout <= 0) {
      interrupt(timeout);
      return;
    }
    void clock.sleep(timeout, ended.signal).then(() => {
      interrupt(timeout);
    });
  };
  const stop = async (): Promise<void> => {
    workflows.forEach((workflow) => {
      workflow.refuse();
    });
    const swept = parts.sweep.stop();
    try {
      await stopComponents(parts.created, async () => {
        await Promise.all([swept, ...workflows.map((workflow) => workflow.settled())]);
        ended.abort();
      });
    } finally {
      ended.abort();
      for (const workflow of workflows) await workflow.app.close();
      markClosed();
    }
  };
  return {
    closed,
    close: (options = {}) => {
      closing ??= stop();
      arm(options.timeout ?? parts.shutdownTimeout);
      return closing;
    },
  };
}
