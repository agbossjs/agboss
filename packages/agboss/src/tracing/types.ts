import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";

/** What a trace is about: the workflow, the conversation thread, the run and its tenant (#261). */
export interface TraceContext {
  readonly bundle: string;
  readonly threadId: string;
  readonly runId: string;
  readonly tenantId: string;
}

/**
 * Optional tracing of runs (LangChain callbacks). Off unless configured — the core runs the same
 * either way; spend and Terns never depend on it.
 */
export interface RunTracing {
  readonly callbacks: (context: TraceContext) => BaseCallbackHandler[];
  /** Link to the conversation in the tracing UI, when the backend knows how to build one. */
  readonly sessionUrl: (threadId: string) => string | undefined;
  /** Sends what is buffered and releases the exporter. */
  readonly shutdown: () => Promise<void>;
}

/** What every exported span's input, output and metadata go through (the PII policies, #120 AC7). */
export interface TraceMask {
  traceData(data: unknown): Promise<unknown>;
}
