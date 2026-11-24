import type { TracerProvider } from "@opentelemetry/api";
import { AppTrace } from "./app-trace.js";
import { OtelCallbackHandler } from "./otel-handler.js";
import type { ExecutionTracing, TraceMask, TracingAdapter } from "./types.js";

/** One tracing per application instance: its workflows share the provider, the masks and the runs in flight. */
const apps = new WeakMap<object, AppTrace>();

/**
 * A workflow's tracing on the application's `tracerProvider` (#1324f): the framework's own
 * OpenTelemetry emitter, masking by `mask` (and by the policies of every workflow of a span's
 * chain) before anything reaches the provider. `route.owner` is the application instance.
 */
export function otelTracing(
  source: TracerProvider | TracingAdapter,
  mask: TraceMask | undefined,
  route: { readonly workflow: string; readonly owner: object },
): ExecutionTracing {
  const app = apps.get(route.owner) ?? new AppTrace(source);
  apps.set(route.owner, app);
  app.join(route.workflow, mask);
  const tracer = app.provider.getTracer("@agboss/core");
  let isClosed = false;
  return {
    callbacks: (context) => [new OtelCallbackHandler(app, tracer, context)],
    traceUrl: (ctx) => app.traceUrl(ctx),
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      if (await app.leave()) apps.delete(route.owner);
    },
  };
}
