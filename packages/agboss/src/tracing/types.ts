import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { TracerProvider } from "@opentelemetry/api";

/** What a trace is about: the workflow, the conversation thread, the run and its tenant (#261). */
export interface TraceContext {
  readonly bundle: string;
  readonly threadId: string;
  readonly runId: string;
  readonly tenantId: string;
}

/**
 * What a tracing backend needs to link one execution (#1324f): its workflow, its thread (the
 * conversation, the session of most backends), its run and its tenant.
 *
 * @public
 */
export interface TraceLinkContext {
  /** The workflow's name (`@Workflow({ name })`). */
  readonly workflow: string;
  /** The conversation thread: the session of most backends. */
  readonly threadId: string;
  /** The execution's id (`ExecutionOutput.executionId`). */
  readonly runId: string;
  /** The tenant the execution works for. */
  readonly tenantId: string;
}

/**
 * A tracing backend the application owns (#1324f): `createApp(App, { tracerProvider: adapter })`.
 * The spans come from the framework's own OpenTelemetry emitter, with every `@PiiPolicy` already
 * applied — a backend never sees an unmasked value. `app.close()` calls `forceFlush` and then
 * `shutdown`. A plain OpenTelemetry `TracerProvider` is the caller's: `app.close()` only flushes it.
 *
 * @public
 */
export interface TracingAdapter {
  /** Where the spans go. */
  readonly tracerProvider: TracerProvider;
  /** The link to one execution in the backend's UI, when it can build one. */
  traceUrl?(ctx: TraceLinkContext): string | undefined;
  /** Sends what is buffered. */
  forceFlush?(): Promise<void>;
  /** Sends what is buffered and releases the exporter. */
  shutdown?(): Promise<void>;
}

/**
 * Optional tracing of runs (LangChain callbacks that emit OpenTelemetry spans). Off unless a
 * `tracerProvider` is given — the core runs the same either way; spend and Turns never depend on it.
 */
export interface ExecutionTracing {
  readonly callbacks: (context: TraceContext) => BaseCallbackHandler[];
  /** Link to the execution in the tracing UI, when the backend knows how to build one. */
  readonly traceUrl: (ctx: TraceLinkContext) => string | undefined;
  /**
   * Flushes the provider; when this is the application's last workflow and the provider is an
   * owned adapter, shuts it down too. A caller-owned `TracerProvider` is only flushed.
   */
  readonly close: () => Promise<void>;
}

/** What every exported span's input, output and metadata go through (the PII policies, #120 AC7). */
export interface TraceMask {
  traceData(data: unknown): Promise<unknown>;
}
