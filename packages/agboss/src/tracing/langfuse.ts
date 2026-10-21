import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { langfuseSettings } from "./settings.js";
import type { ExecutionTracing, TraceMask } from "./types.js";

/**
 * Tracing into a (self-hosted) Langfuse when LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
 * LANGFUSE_BASE_URL are set; undefined otherwise. LANGFUSE_PROJECT_ID (optional) enables links. Uses an isolated tracer provider — the core does
 * not register global OpenTelemetry. Session = conversation thread, tags = workflow and tenant.
 * With a mask, what a span shows is masked before it leaves the process (#120 AC7).
 */
export function langfuseTracing(
  env: NodeJS.ProcessEnv,
  mask?: TraceMask,
): ExecutionTracing | undefined {
  const settings = langfuseSettings(env);
  if (settings === undefined) return undefined;
  const { publicKey, secretKey, baseUrl } = settings;
  const projectId = env.LANGFUSE_PROJECT_ID === "" ? undefined : env.LANGFUSE_PROJECT_ID;
  // every span's input, output and metadata masked by the workflow's PII policies before export
  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    ...(mask === undefined ? {} : { mask: ({ data }: { data: unknown }) => mask.traceData(data) }),
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  return {
    // a trace is filtered by organization (#261 AC6): the tenant as a tag and in the metadata
    callbacks: ({ bundle, threadId, runId, tenantId }) => [
      new CallbackHandler({
        sessionId: threadId,
        tags: [bundle, `tenant:${tenantId}`],
        traceMetadata: { bundle, runId, tenantId },
      }),
    ],
    sessionUrl: (threadId) =>
      projectId === undefined
        ? undefined
        : `${baseUrl.replace(/\/+$/, "")}/project/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(threadId)}`,
    shutdown: async () => {
      await provider.shutdown();
      setLangfuseTracerProvider(null);
    },
  };
}
