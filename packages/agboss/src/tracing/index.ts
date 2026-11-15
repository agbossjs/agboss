/** Optional run tracing (Wiki → Tracing). */
import { langfuseSettings } from "./settings.js";
import type { ExecutionTracing, TraceMask } from "./types.js";
import { lazyLoad } from "../infrastructure/clock.js";

export type { ExecutionTracing, TraceContext, TraceMask } from "./types.js";

/**
 * The app's tracing: Langfuse when configured, else none. The Langfuse and OpenTelemetry modules are
 * loaded only here, when tracing is on — importing `@agboss/core` never loads them (#195). `mask`
 * masks the spans of `workflow`'s runs (#1130: its policies, whatever another workflow lists).
 */
export async function tracingOf(
  env: NodeJS.ProcessEnv,
  mask?: TraceMask,
  workflow?: string,
): Promise<ExecutionTracing | undefined> {
  if (langfuseSettings(env) === undefined) return undefined;
  const { langfuseTracing } = await lazyLoad(import("./langfuse.js"));
  return langfuseTracing(env, mask, workflow);
}
