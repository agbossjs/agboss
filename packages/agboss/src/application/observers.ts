import type { ApplicationContainer, ContainerOptions } from "../components/container/container.js";
import type { ExecutionObserver } from "../core/observer-hooks.js";
import { ExecutionObserverManager, type ObserverFailure } from "../core/observer-manager.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { resolveListed } from "./application-container.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * The observers of an application instance (#261): `@Application({ observers })` only, one instance
 * each from its container, one manager for every workflow — child executions included. A hook that
 * throws is a warning in the application's log (`observer.failed`); the execution goes on.
 */

/** A failing hook, as a warning in the log. */
const failureLoggedTo =
  (log: FrameworkLog): ObserverFailure =>
  (observer, hook, error) => {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("observer.failed", `${observer}.${hook} threw: ${message}`);
  };

/** Observers of an instance besides the application's (a test's call recorder, #262). */
export interface ObserverSeams {
  readonly observers?: readonly ExecutionObserver[];
}

/** The manager of the application's observers, each created now (its hooks run with the others'). */
export function observerManagerOf(
  assembled: AssembledApplication,
  application: ApplicationContainer,
  options: ContainerOptions,
  log: FrameworkLog,
  seams: ObserverSeams = {},
): ExecutionObserverManager {
  // each listed class is checked at assembly to implement observer hooks
  const observers = resolveListed(application, options, assembled.observers) as ExecutionObserver[];
  const all = [...observers, ...(seams.observers ?? [])];
  return new ExecutionObserverManager(all, failureLoggedTo(log));
}
