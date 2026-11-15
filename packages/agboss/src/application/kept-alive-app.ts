import type { BuiltApp } from "../app/create-app.js";
import type { App } from "../app/types.js";
import { keepingAlive } from "../infrastructure/clock.js";

/**
 * A call the caller awaits keeps the process alive until it settles (#1093): its waits on the
 * Clock (a lease held elsewhere, a retry, the shutdown timeout) are timers that do not.
 */
export const keptAlive = (app: App): App => ({
  ...app,
  execute: (start, input, ...options) => keepingAlive(() => app.execute(start, input, ...options)),
  resume: (request, options) => keepingAlive(() => app.resume(request, options)),
  cancel: (threadId, options) => keepingAlive(() => app.cancel(threadId, options)),
  extendPause: (request, options) => keepingAlive(() => app.extendPause(request, options)),
  reassignPause: (request, options) => keepingAlive(() => app.reassignPause(request, options)),
  close: (options) => keepingAlive(() => app.close(options)),
  checkReadiness: () => keepingAlive(() => app.checkReadiness()),
});

/** The calls on a pause, each routed to the workflow its pause waits in (#942, #946). */
export const pauseCallsOf = (
  ofPause: (pauseId: string, tenantId?: string) => Promise<Pick<BuiltApp, "app">>,
): Pick<App, "extendPause" | "reassignPause"> => ({
  extendPause: async (request, options) =>
    (await ofPause(request.pauseId, options?.tenantId)).app.extendPause(request, options),
  reassignPause: async (request, options) =>
    (await ofPause(request.pauseId, options?.tenantId)).app.reassignPause(request, options),
});
