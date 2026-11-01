/** Optional run tracing (Wiki → Tracing). */
import { langfuseSettings } from "./settings.js";
import type { ExecutionTracing, TraceMask } from "./types.js";
import { lazyLoad } from "../infrastructure/clock.js";

export type { ExecutionTracing, TraceContext, TraceMask } from "./types.js";

/**
 * The app's tracing: Langfuse when configured, else none. The Langfuse and OpenTelemetry modules are
 * loaded only here, when tracing is on — importing `agboss` never loads them (#195).
 */
export async function tracingOf(
  env: NodeJS.ProcessEnv,
  mask?: TraceMask,
): Promise<ExecutionTracing | undefined> {
  if (langfuseSettings(env) === undefined) return undefined;
  const { langfuseTracing } = await lazyLoad(import("./langfuse.js"));
  return langfuseTracing(env, mask);
}
