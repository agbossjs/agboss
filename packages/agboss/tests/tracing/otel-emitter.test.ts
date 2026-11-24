/**
 * #1324f: the framework's own OpenTelemetry emitter masks every value BEFORE it is set on a span.
 * An external provider's processors see a span at its start, at each attribute and at its end: the
 * spy processor here records all three, and none of them may ever hold the PII value — nothing
 * relies on a processor that mutates a finished span.
 */
import { SpanKind, SpanStatusCode, type Context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { describe, expect, it } from "vitest";
import { call } from "./callbacks.js";
import { MASK_FAILED } from "../../src/tracing/app-trace.js";
import { WORKFLOW_ATTRIBUTE, WORKFLOW_CHAIN_ATTRIBUTE } from "../../src/tracing/otel-handler.js";
import { tracingOf } from "../../src/tracing/index.js";
import type { TraceMask } from "../../src/tracing/types.js";

const SECRET = "SECRET-4711";
const OTHER_SECRET = "OTHER-9000";

/** Masks one value as the PII policies do: text in, text out. */
const hiding = (value: string, shown: string): TraceMask => ({
  traceData: (data) =>
    Promise.resolve(typeof data === "string" ? data.replaceAll(value, shown) : data),
});

/** A processor that snapshots everything a backend could read, at every moment it can. */
class SpyProcessor implements SpanProcessor {
  readonly seen: string[] = [];
  private snapshot(span: ReadableSpan | Span): string {
    return JSON.stringify({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    });
  }
  onStart(span: Span, _context: Context): void {
    this.seen.push(this.snapshot(span));
  }
  onEnd(span: ReadableSpan): void {
    this.seen.push(this.snapshot(span));
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function setup(masks: Readonly<Record<string, TraceMask | undefined>>) {
  const exporter = new InMemorySpanExporter();
  const spy = new SpyProcessor();
  const provider = new BasicTracerProvider({
    spanProcessors: [spy, new SimpleSpanProcessor(exporter)],
  });
  const owner = {};
  const tracings = Promise.all(
    Object.entries(masks).map(([workflow, mask]) => tracingOf(provider, mask, { workflow, owner })),
  );
  return { exporter, spy, tracings };
}

const run = { bundle: "root", threadId: "thread-1", runId: "run-1", tenantId: "acme" };
const chainOf = (...names: string[]) => JSON.stringify(names);

/** The one handler of a run's callbacks. */
function handlerOf(
  tracing: Awaited<ReturnType<typeof tracingOf>>,
  run: { bundle: string; threadId: string; runId: string; tenantId: string },
): BaseCallbackHandler {
  const [handler] = tracing?.callbacks(run) ?? [];
  if (handler === undefined) throw new Error("no tracing");
  return handler;
}

/** The exported spans and the spy's snapshots as one text. */
const everything = (exporter: InMemorySpanExporter, spy: SpyProcessor): string =>
  [
    ...spy.seen,
    ...exporter
      .getFinishedSpans()
      .map((span) =>
        JSON.stringify({ n: span.name, a: span.attributes, e: span.events, s: span.status }),
      ),
  ].join("\n");

describe("#1324f: the emitter masks before it sets (external providers never see PII)", () => {
  it("input, output, metadata, the session and the tenant are masked before the span carries them", async () => {
    const { exporter, spy, tracings } = setup({ root: hiding(SECRET, "<secret>") });
    const [tracing] = await tracings;
    const handler = handlerOf(tracing, { ...run, threadId: `thread-${SECRET}` });

    call(
      handler,
      "handleChainStart",
      { id: ["Chain"] },
      { text: `my ${SECRET}` },
      "r1",
      undefined,
      [`tag-${SECRET}`],
      { workflowName: "root", workflowChain: chainOf("root"), note: `meta ${SECRET}` },
      "chain",
      "step",
    );
    call(handler, "handleChainEnd", { reply: `ok ${SECRET}` }, "r1");
    await tracing?.close();

    const text = everything(exporter, spy);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("<secret>");
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes["input.value"]).toBe('{"text":"my <secret>"}');
    expect(span?.attributes["output.value"]).toBe('{"reply":"ok <secret>"}');
    expect(span?.attributes["session.id"]).toBe("thread-<secret>");
    expect(span?.attributes["agboss.metadata.note"]).toBe("meta <secret>");
    expect(span?.attributes["tag.tags"]).toEqual(["tag-<secret>"]);
  });

  it("an error's text, its type, its event and its status message are masked too", async () => {
    const { exporter, spy, tracings } = setup({ root: hiding(SECRET, "<secret>") });
    const [tracing] = await tracings;
    const handler = handlerOf(tracing, run);
    const failure = new Error(`failed for ${SECRET}`);
    failure.name = `Error${SECRET}`;

    call(
      handler,
      "handleToolStart",
      { id: ["Tool"] },
      `{"q":"${SECRET}"}`,
      "r1",
      undefined,
      [],
      {},
      "lookup",
    );
    call(handler, "handleToolError", failure, "r1");
    await tracing?.close();

    expect(everything(exporter, spy)).not.toContain(SECRET);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "failed for <secret>" });
    expect(span?.events.map((event) => event.name)).toEqual(["exception"]);
    expect(span?.events[0]?.attributes?.["exception.message"]).toBe("failed for <secret>");
    expect(span?.kind).toBe(SpanKind.INTERNAL);
  });

  it("a model call: the prompt and the answer are masked, the token counts are numbers", async () => {
    const { exporter, spy, tracings } = setup({ root: hiding(SECRET, "<secret>") });
    const [tracing] = await tracings;
    const handler = handlerOf(tracing, run);

    call(
      handler,
      "handleLLMStart",
      { id: ["ChatModel"] },
      [`say ${SECRET}`],
      "m1",
      undefined,
      { invocation_params: { model: "gpt-x" } },
      [],
      {},
      "model-call",
    );
    call(
      handler,
      "handleLLMEnd",
      {
        generations: [
          [
            {
              text: `said ${SECRET}`,
              message: { usage_metadata: { input_tokens: 7, output_tokens: 3 } },
            },
          ],
        ],
      },
      "m1",
    );
    await tracing?.close();

    expect(everything(exporter, spy)).not.toContain(SECRET);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toMatchObject({
      "gen_ai.request.model": "gpt-x",
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.output_tokens": 3,
    });
  });

  it("a mask that throws leaves MASK_FAILED, never the value; one that returns a non-text does the same", async () => {
    const throwing: TraceMask = { traceData: () => Promise.reject(new Error("mask down")) };
    const odd: TraceMask = { traceData: () => Promise.resolve({ not: "text" }) };
    for (const mask of [throwing, odd]) {
      const { exporter, spy, tracings } = setup({ root: mask });
      const [tracing] = await tracings;
      const handler = handlerOf(tracing, run);
      call(
        handler,
        "handleChainStart",
        { id: ["C"] },
        SECRET,
        "r1",
        undefined,
        [],
        {},
        "chain",
        "step",
      );
      call(handler, "handleChainEnd", SECRET, "r1");
      await tracing?.close();

      expect(everything(exporter, spy)).not.toContain(SECRET);
      expect(exporter.getFinishedSpans()[0]?.attributes["input.value"]).toBe(MASK_FAILED);
    }
  });

  it("a child's spans are masked by every workflow of its chain (#1150); the root's by its own only", async () => {
    const { exporter, spy, tracings } = setup({
      root: hiding(SECRET, "<root-secret>"),
      child: hiding(OTHER_SECRET, "<child-secret>"),
    });
    const [tracing] = await tracings;
    const handler = handlerOf(tracing, run);
    const text = `${SECRET} and ${OTHER_SECRET}`;

    call(
      handler,
      "handleChainStart",
      { id: ["C"] },
      text,
      "root-run",
      undefined,
      [],
      {
        workflowName: "root",
        workflowChain: chainOf("root"),
      },
      "chain",
      "root-step",
    );
    call(
      handler,
      "handleChainStart",
      { id: ["C"] },
      text,
      "child-run",
      "root-run",
      [],
      {
        workflowName: "child",
        workflowChain: chainOf("root", "child"),
      },
      "chain",
      "child-step",
    );
    call(handler, "handleChainEnd", text, "child-run");
    call(handler, "handleChainEnd", text, "root-run");
    await tracing?.close();

    const spans = exporter.getFinishedSpans();
    const of = (workflow: string): ReadableSpan => {
      const found = spans.find((span) => span.attributes[WORKFLOW_ATTRIBUTE] === workflow);
      if (found === undefined) throw new Error(`no span of ${workflow}`);
      return found;
    };
    // the child: masked by both its root's and its own policy
    expect(of("child").attributes["input.value"]).toBe("<root-secret> and <child-secret>");
    expect(of("child").attributes[WORKFLOW_CHAIN_ATTRIBUTE]).toBe(chainOf("root", "child"));
    // the root: its own policy only
    expect(of("root").attributes["input.value"]).toBe(`<root-secret> and ${OTHER_SECRET}`);
    // the child's span nests under its parent's
    expect(of("child").parentSpanContext?.spanId).toBe(of("root").spanContext().spanId);
    expect(spy.seen.join("\n")).not.toContain(`"${SECRET}`);
  });

  it("a chain naming a workflow of no route, or no chain at all: the union of the application's masks (fail closed)", async () => {
    const { exporter, spy, tracings } = setup({
      root: hiding(SECRET, "<a>"),
      other: hiding(OTHER_SECRET, "<b>"),
    });
    const [tracing] = await tracings;
    const handler = handlerOf(tracing, run);
    const text = `${SECRET}/${OTHER_SECRET}`;

    call(
      handler,
      "handleChainStart",
      { id: ["C"] },
      text,
      "r1",
      undefined,
      [],
      {
        workflowName: "ghost",
        workflowChain: chainOf("root", "ghost"),
      },
      "chain",
      "unknown-chain",
    );
    call(
      handler,
      "handleChainStart",
      { id: ["C"] },
      text,
      "r2",
      undefined,
      [],
      {},
      "chain",
      "no-chain",
    );
    call(handler, "handleChainEnd", text, "r1");
    call(handler, "handleChainEnd", text, "r2");
    await tracing?.close();

    expect(everything(exporter, spy)).not.toContain(SECRET);
    expect(everything(exporter, spy)).not.toContain(OTHER_SECRET);
  });

  it("a span whose handler method throws, or whose run is unknown, never throws into the run", async () => {
    const { tracings } = setup({ root: undefined });
    const [tracing] = await tracings;
    const handler = handlerOf(tracing, run);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => {
      call(handler, "handleChainEnd", "x", "never-started");
      call(
        handler,
        "handleChainStart",
        { id: ["C"] },
        circular,
        "r1",
        undefined,
        [],
        undefined,
        "chain",
        "c",
      );
      call(handler, "handleChainEnd", circular, "r1");
    }).not.toThrow();
    await tracing?.close();
  });
});
