import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { langfuseSettings } from "./settings.js";
import { TraceRouter, type TraceRoute } from "./trace-router.js";
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

type Handler = CallbackHandler;

/**
 * Langfuse's handler whose spans are bound to one route (#1130): every method that starts a span
 * starts it inside `route.starting`, so the span — and its children — are exported through that
 * route's processor and masked by its application's policies, whatever other routes exist.
 */
class RoutedCallbackHandler extends CallbackHandler {
  constructor(
    private readonly route: TraceRoute,
    params: ConstructorParameters<typeof CallbackHandler>[0],
  ) {
    super(params);
  }

  override handleChainStart(...args: Parameters<Handler["handleChainStart"]>): Promise<void> {
    return this.route.starting(() => super.handleChainStart(...args));
  }

  override handleAgentAction(...args: Parameters<Handler["handleAgentAction"]>): Promise<void> {
    return this.route.starting(() => super.handleAgentAction(...args));
  }

  override handleChatModelStart(
    ...args: Parameters<Handler["handleChatModelStart"]>
  ): Promise<void> {
    return this.route.starting(() => super.handleChatModelStart(...args));
  }

  override handleLLMStart(...args: Parameters<Handler["handleLLMStart"]>): Promise<void> {
    return this.route.starting(() => super.handleLLMStart(...args));
  }

  override handleToolStart(...args: Parameters<Handler["handleToolStart"]>): Promise<void> {
    return this.route.starting(() => super.handleToolStart(...args));
  }

  override handleRetrieverStart(
    ...args: Parameters<Handler["handleRetrieverStart"]>
  ): Promise<void> {
    return this.route.starting(() => super.handleRetrieverStart(...args));
  }
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
 * every string attribute, by that workflow's policies (#1130). `owner` is the application instance
 * the workflow belongs to: its spans go only to its own processor, masked by its own policies.
 */
export function langfuseTracing(
  env: NodeJS.ProcessEnv,
  mask: TraceMask | undefined,
  route: { readonly workflow: string; readonly owner: object },
): ExecutionTracing | undefined {
  const settings = langfuseSettings(env);
  if (settings === undefined) return undefined;
  const { publicKey, secretKey, baseUrl } = settings;
  const projectId = env.LANGFUSE_PROJECT_ID === "" ? undefined : env.LANGFUSE_PROJECT_ID;
  const routed = sharedRouter().addRoute({
    ...route,
    mask,
    settingsKey: JSON.stringify([publicKey, secretKey, baseUrl]),
    // masked by the router before it reaches the processor: no mask of its own
    processor: () => new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl }),
  });
  return {
    // a trace is filtered by organization (#261 AC6): the tenant as a tag and in the metadata
    callbacks: ({ bundle, threadId, runId, tenantId }) => [
      new RoutedCallbackHandler(routed, {
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
      await routed.remove();
      await releasedIfIdle();
    },
  };
}
