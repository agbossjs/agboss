/** Optional run tracing (Wiki → Tracing). */
import type { TracerProvider } from "@opentelemetry/api";
import type { ExecutionTracing, TraceMask, TracingAdapter } from "./types.js";
import { lazyLoad } from "../infrastructure/clock.js";

export type {
  ExecutionTracing,
  TraceContext,
  TraceLinkContext,
  TraceMask,
  TracingAdapter,
} from "./types.js";

/**
 * The app's tracing: spans on the `tracerProvider` it was given, else none. The OpenTelemetry
 * emitter is loaded only here, when tracing is on — importing `@agboss/core` never loads it (#195).
 * `mask` masks the spans of `route.workflow`'s runs (#1130: its policies, whatever another workflow
 * lists), before they reach the provider; `route.owner` is the application instance.
 */
export async function tracingOf(
  source: TracerProvider | TracingAdapter | undefined,
  mask: TraceMask | undefined,
  route: { readonly workflow: string; readonly owner: object },
): Promise<ExecutionTracing | undefined> {
  if (source === undefined) return undefined;
  const { otelTracing } = await lazyLoad(import("./otel-tracing.js"));
  return otelTracing(source, mask, route);
}
