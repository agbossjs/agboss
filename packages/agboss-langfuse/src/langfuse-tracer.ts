import type { TraceLinkContext, TracingAdapter } from "@agboss/core";
import { isDefaultExportSpan, LangfuseSpanProcessor } from "@langfuse/otel";
import type { TracerProvider } from "@opentelemetry/api";
import { BasicTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-base";

/** What `LangfuseTracer` needs: the project's keys, the server, and (for links) the project. */
export interface LangfuseTracerOptions {
  /** The project's public key. */
  readonly publicKey: string;
  /** The project's secret key. */
  readonly secretKey: string;
  /** The Langfuse server, e.g. `https://cloud.langfuse.com` or your self-hosted one. */
  readonly baseUrl: string;
  /** The project's id: with it `ExecutionOutput.traceUrl` links the conversation (the session). */
  readonly projectId?: string | undefined;
  /** Replaces the OTLP exporter to Langfuse (tests). */
  readonly exporter?: SpanExporter | undefined;
}

/**
 * The instrumentation scope of the framework's own spans. Langfuse exports by default only the spans
 * it knows are LLM spans, which would drop the framework's chains, steps and tool calls.
 */
const AGBOSS_SCOPE = "@agboss/core";

const present = (value: string | undefined): value is string => value !== undefined && value !== "";

/**
 * Langfuse as the application's tracing backend: `createApp(App, { tracerProvider: new
 * LangfuseTracer({ publicKey, secretKey, baseUrl }) })`.
 *
 * The framework emits its own OpenTelemetry spans and applies the `@PiiPolicy` policies to every
 * value before it reaches this tracer's provider — nothing here masks, and nothing needs to.
 * The provider is isolated: the process's global OpenTelemetry is not touched. The application
 * owns the tracer: `app.close()` flushes it and shuts it down.
 */
export class LangfuseTracer implements TracingAdapter {
  readonly tracerProvider: TracerProvider;
  private readonly provider: BasicTracerProvider;
  private readonly sessions: string | undefined;

  constructor(options: LangfuseTracerOptions) {
    const { publicKey, secretKey, baseUrl, projectId, exporter } = options;
    for (const [name, value] of Object.entries({ publicKey, secretKey, baseUrl }))
      if (!present(value)) throw new TypeError(`LangfuseTracer: ${name} is required`);
    this.provider = new BasicTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey,
          secretKey,
          baseUrl,
          shouldExportSpan: ({ otelSpan }) =>
            otelSpan.instrumentationScope.name === AGBOSS_SCOPE || isDefaultExportSpan(otelSpan),
          ...(exporter === undefined ? {} : { exporter, exportMode: "immediate" as const }),
        }),
      ],
    });
    this.tracerProvider = this.provider;
    this.sessions = present(projectId)
      ? `${baseUrl.replace(/\/+$/, "")}/project/${encodeURIComponent(projectId)}/sessions/`
      : undefined;
  }

  /**
   * A Langfuse tracer from `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`
   * (and `LANGFUSE_PROJECT_ID` for links) — `undefined` when the three are not all set.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LangfuseTracer | undefined {
    const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = env;
    const { LANGFUSE_BASE_URL: baseUrl, LANGFUSE_PROJECT_ID: projectId } = env;
    return present(publicKey) && present(secretKey) && present(baseUrl)
      ? new LangfuseTracer({ publicKey, secretKey, baseUrl, projectId })
      : undefined;
  }

  /** The conversation (session = thread) in Langfuse's UI; none without a `projectId`. */
  traceUrl(ctx: TraceLinkContext): string | undefined {
    return this.sessions === undefined
      ? undefined
      : `${this.sessions}${encodeURIComponent(ctx.threadId)}`;
  }

  async forceFlush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}
