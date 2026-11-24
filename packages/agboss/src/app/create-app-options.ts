import type { MeterProvider, TracerProvider } from "@opentelemetry/api";
import type { ProfileSelection } from "../config/profile-names.js";
import type { TracingAdapter } from "../tracing/types.js";

/**
 * `createApp` options (#834): the environment, the profiles layered on the application, and where the
 * instance publishes its metrics and its spans — nothing else. Infrastructure is listed in
 * `@Application({ providers })`; every other setting is an `@Application` option, and the seams a
 * test or a tool replaces (models, MCP transports, the process environment) are on the internal
 * build path only (`testWith`, the CLI).
 */
export interface CreateAppOptions {
  /**
   * The environment: `environments/<env>.environment.ts` next to the application file (default
   * `dev`) — of an application that declares `@Application({ environment })`.
   */
  readonly env?: string | undefined;
  /**
   * The profiles: `src/config/<name>.config.ts|yaml` next to the application file, layered left to
   * right over `base.config.*` — `"prod"`, `"prod,economy"` (or `"prod+economy"`) or
   * `["prod", "economy"]`. Default `"dev"`; a profile that is named and has no file fails, naming
   * the ones that exist.
   */
  readonly profile?: ProfileSelection | undefined;
  /**
   * Where the instance publishes its metrics (#485, Wiki → Metrics): an OpenTelemetry
   * `MeterProvider` — an SDK one with a Prometheus or an OTLP exporter, or the global one
   * (`metrics.getMeterProvider()`). A runtime object, so an option here and not of `@Application`.
   * Absent = no metrics: nothing loaded, no store read.
   */
  readonly meterProvider?: MeterProvider;
  /**
   * Where the instance's spans go (#1324f, Wiki → Tracing): vendor-neutral OpenTelemetry. Either
   * your own `TracerProvider` (`app.close()` only flushes it: you shut it down), or a
   * `TracingAdapter` such as `LangfuseTracer` from `@agboss/langfuse` (the application owns it:
   * `app.close()` flushes and shuts it down, and `ExecutionOutput.traceUrl` is its link). Whatever
   * provider, every value is masked by the workflow's `@PiiPolicy` policies — a child workflow's
   * by its ancestors' too — before it is set on a span. Absent = no tracing.
   */
  readonly tracerProvider?: TracerProvider | TracingAdapter;
}
