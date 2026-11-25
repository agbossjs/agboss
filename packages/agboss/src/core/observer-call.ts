import type { ExecutionObserver, ObserverHook } from "./observer-hooks.js";

/** Told when an observer's hook throws; the execution goes on. */
export type ObserverFailure = (observer: string, hook: ObserverHook, error: unknown) => void;

/** Calls `call` on each observer in order; one that throws is reported and skipped, never fatal. */
export async function callAll<TEvent>(
  observers: readonly ExecutionObserver[],
  hook: ObserverHook,
  event: TEvent,
  call: (observer: ExecutionObserver, event: TEvent) => Promise<void> | void,
  onFailure: ObserverFailure,
): Promise<void> {
  for (const observer of observers) {
    try {
      await call(observer, event);
    } catch (error) {
      onFailure(observer.constructor.name, hook, error);
    }
  }
}
