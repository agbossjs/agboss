import type { TracerProvider } from "@opentelemetry/api";
import { tracingOf, type ExecutionTracing, type TracingAdapter } from "../tracing/index.js";
import type { TraceMask } from "../tracing/types.js";

/**
 * A workflow's tracing (#1324f, #1130): its spans go to the application instance's `tracerProvider`
 * only (`parts.infrastructure` is one per instance), masked by the workflow's policies.
 */
export const tracingFor = (
  options: { readonly tracerProvider?: TracerProvider | TracingAdapter },
  mask: TraceMask | undefined,
  workflow: string,
  parts: { readonly infrastructure: object },
): Promise<ExecutionTracing | undefined> =>
  tracingOf(options.tracerProvider, mask, { workflow, owner: parts.infrastructure });
