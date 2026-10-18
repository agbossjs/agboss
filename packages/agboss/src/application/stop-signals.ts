import type { App } from "../app/types.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { seconds } from "../units/index.js";

/**
 * The stop signals of the process (#265 S51): `createApp` listens for SIGTERM (a platform stopping
 * the instance, e.g. Cloud Run, Kubernetes) and SIGINT (Ctrl+C) and calls `app.close()` — the
 * graceful stop with its shutdown timeout; a second signal while it stops interrupts at once. The
 * listeners are removed when `close()` finishes, however it was called; then, when nothing else
 * listens for the signal received, it is raised again, so the process ends as it would have
 * without the app (its default action). `testWith` never listens.
 */

/** The stop signals an app instance listens for. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/** What the listeners need of the process (the process itself in production). */
export interface StopSignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  listenerCount(signal: NodeJS.Signals): number;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  readonly pid: number;
}

/** What closing an app on a stop signal needs: its close, and when that has finished. */
export interface ClosableApp {
  readonly app: Pick<App, "close">;
  readonly closed: Promise<void>;
  /** Where a failed close is reported: the application's log. */
  readonly log: FrameworkLog;
}

/** Listens for SIGTERM / SIGINT until the app's `close()` has finished. */
export function closeOnStopSignals(
  { app, closed, log }: ClosableApp,
  source: StopSignalSource = process,
): void {
  let received: NodeJS.Signals | undefined;
  const listener = (signal: NodeJS.Signals): void => {
    const again = received !== undefined;
    received ??= signal;
    // the close's own failures are the app's (hooks collected into one error): reported, not thrown
    app.close(again ? { timeout: seconds(0) } : {}).catch((error: unknown) => {
      log.error("app.close-failed", `app.close() on ${signal} failed: ${String(error)}`);
    });
  };
  STOP_SIGNALS.forEach((signal) => source.on(signal, listener));
  void closed.then(() => {
    STOP_SIGNALS.forEach((signal) => source.off(signal, listener));
    if (received !== undefined && source.listenerCount(received) === 0) {
      source.kill(source.pid, received);
    }
  });
}
