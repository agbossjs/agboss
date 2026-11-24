import type { BuiltApp } from "../app/create-app.js";
import type { AnyTenantApp } from "../app/types.js";
import { tenantGated } from "./tenant-gated-app.js";
import { keepingAlive } from "../infrastructure/clock.js";

/**
 * A call the caller awaits keeps the process alive until it settles (#1093): its waits on the
 * Clock (a lease held elsewhere, a retry, the shutdown timeout) are timers that do not. The calls
 * that need a tenant are refused first when the application declares a `tenantContext` (#1324e).
 */
export const keptAlive = (tenanted: boolean, app: AnyTenantApp): AnyTenantApp =>
  tenantGated(tenanted, {
    ...app,
    execute: (start, input, ...options) =>
      keepingAlive(() => app.execute(start, input, ...options)),
    resume: (request, options) => keepingAlive(() => app.resume(request, options)),
    cancel: (threadId, options) => keepingAlive(() => app.cancel(threadId, options)),
    stop: (threadId, options) => keepingAlive(() => app.stop(threadId, options)),
    pause: (threadId, options) => keepingAlive(() => app.pause(threadId, options)),
    unpause: (threadId, options) => keepingAlive(() => app.unpause(threadId, options)),
    extendPause: (request, options) => keepingAlive(() => app.extendPause(request, options)),
    reassignPause: (request, options) => keepingAlive(() => app.reassignPause(request, options)),
    close: (options) => keepingAlive(() => app.close(options)),
    checkReadiness: () => keepingAlive(() => app.checkReadiness()),
  });

/** The calls on a pause, each routed to the workflow its pause waits in (#942, #946). */
export const pauseCallsOf = (
  ofPause: (pauseId: string, tenantId?: string) => Promise<Pick<BuiltApp, "app">>,
): Pick<AnyTenantApp, "extendPause" | "reassignPause"> => ({
  extendPause: async (request, options) =>
    (await ofPause(request.pauseId, options?.tenantId)).app.extendPause(request, options),
  reassignPause: async (request, options) =>
    (await ofPause(request.pauseId, options?.tenantId)).app.reassignPause(request, options),
});
