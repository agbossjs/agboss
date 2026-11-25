import type { ExecutionTracing, TraceLinkContext } from "./types.js";

/**
 * The `traceUrl` an execution's output carries, whatever its status — finished, paused, stopped or
 * cancelled (#1324f): the tracing backend's link to it, or no field when there is none.
 */
export const traceUrlFieldOf = (
  tracing: ExecutionTracing | undefined,
  ctx: TraceLinkContext,
): { traceUrl?: string } => {
  const traceUrl = tracing?.traceUrl(ctx);
  return traceUrl === undefined ? {} : { traceUrl };
};
