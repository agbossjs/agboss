import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { langfuseSettings } from "./settings.js";
import { TraceRouter } from "./trace-router.js";
import type { ExecutionTracing, TraceMask } from "./types.js";

/**
 * The process's Langfuse tracer provider (#1130): Langfuse's LangChain handler always exports
 * through ONE process-wide provider (`setLangfuseTracerProvider`), so every workflow's tracing is
 * a route of one `TraceRouter` — each span masked by the policies of the workflow it belongs to,
 * never by whichever workflow was built last.
 */
let shared: { readonly router: TraceRouter; readonly provider: BasicTracerProvider } | undefined;

function sharedRouter(): TraceRouter {
  if (shared === undefined) {
    const router = new TraceRouter();
    const provider = new BasicTracerProvider({ spanProcessors: [router] });
    setLangfuseTracerProvider(provider);
    shared = { router, provider };
  }
  return shared.router;
}

/** The last route left: the provider is released (nothing traces until a new one starts). */
async function releasedIfIdle(): Promise<void> {
  if (!shared?.router.isIdle) return;
  const { provider } = shared;
  shared = undefined;
  setLangfuseTracerProvider(null);
  await provider.shutdown();
}

/**
 * Tracing into a (self-hosted) Langfuse when LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
 * LANGFUSE_BASE_URL are set; undefined otherwise. LANGFUSE_PROJECT_ID (optional) enables links. Uses an isolated tracer provider — the core does
 * not register global OpenTelemetry. Session = conversation thread, tags = workflow and tenant.
 * With a mask, what a span of `workflow` shows is masked before it leaves the process (#120 AC7):
 * every string attribute, by that workflow's policies (#1130).
 */
export function langfuseTracing(
  env: NodeJS.ProcessEnv,
  mask?: TraceMask,
  workflow?: string,
): ExecutionTracing | undefined {
  const settings = langfuseSettings(env);
  if (settings === undefined) return undefined;
  const { publicKey, secretKey, baseUrl } = settings;
  const projectId = env.LANGFUSE_PROJECT_ID === "" ? undefined : env.LANGFUSE_PROJECT_ID;
  const route = sharedRouter().addRoute({
    workflow,
    mask,
    settingsKey: JSON.stringify([publicKey, secretKey, baseUrl]),
    // masked by the router before it reaches the processor: no mask of its own
    processor: () => new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl }),
  });
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
      // LangChain may still be running handlers in the background: their spans end on this route
      await awaitAllCallbacks();
      await route.remove();
      await releasedIfIdle();
    },
  };
}
