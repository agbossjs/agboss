/** #1130: the process's one Langfuse span processor masks each span by its own workflow's mask. */
import type { Attributes } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { getLangfuseTracerProvider } from "@langfuse/tracing";
import { describe, expect, it } from "vitest";
import { langfuseTracing } from "../../src/tracing/langfuse.js";
import { MASK_FAILED, TraceRouter, WORKFLOW_ATTRIBUTE } from "../../src/tracing/trace-router.js";
import type { TraceMask } from "../../src/tracing/types.js";

/** A processor that keeps what it is handed. */
class KeptSpans implements SpanProcessor {
  readonly started: object[] = [];
  readonly ended: ReadableSpan[] = [];
  isShutDown = false;
  onStart(span: Span): void {
    this.started.push(span);
  }
  onEnd(span: ReadableSpan): void {
    this.ended.push(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    this.isShutDown = true;
    return Promise.resolve();
  }
}

/** A mask that replaces one word, the way a policy replaces its kind. */
const hiding = (word: string): TraceMask => ({
  traceData: (data) =>
    Promise.resolve(
      Array.isArray(data)
        ? data.map((item) => String(item).replaceAll(word, `<${word}>`))
        : String(data).replaceAll(word, `<${word}>`),
    ),
});

/** One span through a provider on `router`, as the exporting processor got it once it ended. */
async function ended(
  router: TraceRouter,
  processor: KeptSpans,
  attributes: Attributes,
): Promise<ReadableSpan> {
  const provider = new BasicTracerProvider({ spanProcessors: [router] });
  provider.getTracer("trace-router-test").startSpan("step", { attributes }).end();
  await router.forceFlush();
  const span = processor.ended.at(-1);
  if (span === undefined) throw new Error("no span was exported");
  return span;
}

const twoRoutes = () => {
  const processor = new KeptSpans();
  const router = new TraceRouter();
  const make = () => processor;
  const ticket = router.addRoute({
    workflow: "ticket-workflow",
    mask: hiding("TCK-1"),
    settingsKey: "lf",
    processor: make,
  });
  const refund = router.addRoute({
    workflow: "refund-workflow",
    settingsKey: "lf",
    processor: make,
  });
  return { router, processor, ticket, refund };
};

describe("#1130: TraceRouter", () => {
  it("R1: a span of a workflow is masked by that workflow's mask — the one built last lists none", async () => {
    const { router, processor } = twoRoutes();

    const span = await ended(router, processor, {
      [WORKFLOW_ATTRIBUTE]: "ticket-workflow",
      "langfuse.observation.input": '{"text":"about TCK-1"}',
      "langfuse.observation.metadata.note": "TCK-1",
      "langfuse.trace.tags": ["TCK-1"],
      "langfuse.observation.level": 1,
    });

    expect(processor.started).toHaveLength(1);
    expect(processor.ended).toEqual([span]);
    expect(JSON.stringify(span.attributes)).not.toMatch(/TCK-1(?!>)/);
    expect(span.attributes["langfuse.observation.metadata.note"]).toBe("<TCK-1>");
    expect(span.attributes["langfuse.trace.tags"]).toEqual(["<TCK-1>"]);
    expect(span.attributes["langfuse.observation.level"]).toBe(1);
  });

  it("R2: a span of a workflow without policies is not masked by another's", async () => {
    const { router, processor } = twoRoutes();

    const span = await ended(router, processor, {
      [WORKFLOW_ATTRIBUTE]: "refund-workflow",
      "langfuse.observation.input": "TCK-1",
    });

    expect(span.attributes["langfuse.observation.input"]).toBe("TCK-1");
  });

  it("R3: a span of no known workflow is masked by every route's mask (fail closed)", async () => {
    const { router, processor } = twoRoutes();
    router.addRoute({
      workflow: "third-workflow",
      mask: hiding("EMP-2"),
      settingsKey: "lf",
      processor: () => new KeptSpans(),
    });

    const nameless = await ended(router, processor, {
      "langfuse.observation.input": "TCK-1 EMP-2",
    });
    const unknown = await ended(router, processor, {
      [WORKFLOW_ATTRIBUTE]: "gone-workflow",
      "langfuse.observation.input": "TCK-1 EMP-2",
    });

    expect(nameless.attributes["langfuse.observation.input"]).toBe("<TCK-1> <EMP-2>");
    expect(unknown.attributes["langfuse.observation.input"]).toBe("<TCK-1> <EMP-2>");
  });

  it("R4: a mask that throws leaves MASK_FAILED, never the value", async () => {
    const router = new TraceRouter();
    const processor = new KeptSpans();
    const broken: TraceMask = { traceData: () => Promise.reject(new Error("TCK-1")) };
    router.addRoute({
      workflow: "w",
      mask: broken,
      settingsKey: "lf",
      processor: () => processor,
    });

    const span = await ended(router, processor, {
      [WORKFLOW_ATTRIBUTE]: "w",
      "langfuse.observation.output": "TCK-1",
    });

    expect(span.attributes["langfuse.observation.output"]).toBe(MASK_FAILED);
    expect(span.attributes[WORKFLOW_ATTRIBUTE]).toBe(MASK_FAILED);
  });

  it("R5: a route that leaves keeps the shared processor for the others; the last one shuts it", async () => {
    const { router, processor, ticket, refund } = twoRoutes();

    await ticket.remove();
    const span = await ended(router, processor, { "langfuse.observation.input": "TCK-1" });

    expect(processor.isShutDown).toBe(false);
    expect(processor.ended).toEqual([span]);
    expect(span.attributes["langfuse.observation.input"]).toBe("TCK-1");
    await refund.remove();
    expect(processor.isShutDown).toBe(true);
    expect(router.isIdle).toBe(true);
  });

  it("R6: Langfuse's process-wide provider stays the masking one until the last tracing shuts down", async () => {
    const env = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-1130",
      LANGFUSE_SECRET_KEY: "sk-lf-1130",
      LANGFUSE_BASE_URL: "http://127.0.0.1:9",
    };
    const first = langfuseTracing(env, hiding("TCK-1"), "ticket-workflow");
    const provider = getLangfuseTracerProvider();
    const second = langfuseTracing(env, undefined, "refund-workflow");

    expect(getLangfuseTracerProvider()).toBe(provider);
    await first?.shutdown();
    expect(getLangfuseTracerProvider()).toBe(provider);
    await second?.shutdown();
    expect(getLangfuseTracerProvider()).not.toBe(provider);
  });
});
