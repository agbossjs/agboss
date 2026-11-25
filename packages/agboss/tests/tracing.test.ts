import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { TracerProvider } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  tracingOf,
  type ExecutionTracing,
  type TraceContext,
  type TracingAdapter,
} from "../src/tracing/index.js";
import { routeTo, fakeDeps, runText } from "./helpers.js";
import { call } from "./tracing/callbacks.js";

const LINK = { workflow: "job-scout", threadId: "t 1", runId: "r-1", tenantId: "acme" };

/** Records which graph nodes started — proves callbacks reach the graph. */
class NodeRecorder extends BaseCallbackHandler {
  name = "node-recorder";
  readonly started: string[] = [];
  // LangChain calls (chain, inputs, runId, parentRunId, tags, metadata, runType, runName)
  override handleChainStart(...args: unknown[]): void {
    const runName = args[7];
    if (typeof runName === "string") this.started.push(runName);
  }
}

/** A provider the caller owns: it counts what `app.close()` does to it. */
class CountingProvider extends BasicTracerProvider {
  readonly calls: string[] = [];
  override async forceFlush(): Promise<void> {
    this.calls.push("forceFlush");
    await super.forceFlush();
  }
  override async shutdown(): Promise<void> {
    this.calls.push("shutdown");
    await super.shutdown();
  }
}

/** An adapter the application owns. */
function adapterOf(calls: string[], provider: TracerProvider = new BasicTracerProvider()) {
  const adapter: TracingAdapter = {
    tracerProvider: provider,
    traceUrl: (ctx) => `http://traces/${encodeURIComponent(ctx.threadId)}?run=${ctx.runId}`,
    forceFlush: () => {
      calls.push("forceFlush");
      return Promise.resolve();
    },
    shutdown: () => {
      calls.push("shutdown");
      return Promise.resolve();
    },
  };
  return adapter;
}

describe("tracing (#1324f)", () => {
  it("is off without a tracerProvider: no tracing, nothing loaded", async () => {
    await expect(tracingOf(undefined, undefined, { workflow: "w", owner: {} })).resolves.toBe(
      undefined,
    );
  });

  it("an adapter links the execution: its workflow, thread, run and tenant", async () => {
    const tracing = await tracingOf(adapterOf([]), undefined, { workflow: "job-scout", owner: {} });

    expect(tracing?.traceUrl(LINK)).toBe("http://traces/t%201?run=r-1");
    await tracing?.close();
  });

  it("a plain TracerProvider has no link; one whose traceUrl throws gives none, never an error", async () => {
    const plain = await tracingOf(new BasicTracerProvider(), undefined, {
      workflow: "w",
      owner: {},
    });
    expect(plain?.traceUrl(LINK)).toBeUndefined();
    const throwing = await tracingOf(
      {
        tracerProvider: new BasicTracerProvider(),
        traceUrl: () => {
          throw new Error("backend down");
        },
      },
      undefined,
      { workflow: "w", owner: {} },
    );
    expect(throwing?.traceUrl(LINK)).toBeUndefined();
    await plain?.close();
    await throwing?.close();
  });

  it("one handler per run; the run's first span carries the thread as its session", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracing = await tracingOf(provider, undefined, { workflow: "job-scout", owner: {} });
    const context: TraceContext = {
      bundle: "job-scout",
      threadId: "t-1",
      runId: "r-1",
      tenantId: "acme",
    };

    const handlers = tracing?.callbacks(context) ?? [];
    expect(handlers).toHaveLength(1);
    const [handler] = handlers;
    if (handler === undefined) throw new Error("no handler");
    call(
      handler,
      "handleChainStart",
      { id: ["x"] },
      { a: 1 },
      "run-1",
      undefined,
      [],
      {},
      "chain",
      "job",
    );
    call(handler, "handleChainEnd", { b: 2 }, "run-1");
    await tracing?.close();

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("job");
    expect(span?.attributes).toMatchObject({
      "session.id": "t-1",
      "agboss.tenant.id": "acme",
      "agboss.run.id": "r-1",
      "input.value": '{"a":1}',
      "output.value": '{"b":2}',
    });
  });

  it("passes the callbacks to the graph run with the thread and run ids", async () => {
    const recorder = new NodeRecorder();
    const seen: TraceContext[] = [];
    const tracing: ExecutionTracing = {
      callbacks: (context) => {
        seen.push(context);
        return [recorder];
      },
      traceUrl: (ctx) => `http://traces/sessions/${ctx.threadId}`,
      close: () => Promise.resolve(),
    };
    const deps = {
      ...(await fakeDeps({ "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] })),
      tracing,
    };

    const result = await runText("Hi", deps);

    expect(seen).toEqual([
      {
        bundle: "test-bundle-workflow",
        threadId: result.threadId,
        runId: result.runId,
        tenantId: "default",
      },
    ]);
    expect(recorder.started).toEqual(
      expect.arrayContaining(["main-router", "alpha-agent", "answer-workflow-finish"]),
    );
    expect(result.traceUrl).toBe(`http://traces/sessions/${result.threadId}`);
  });

  it("without tracing the output has no link", async () => {
    const plain = await runText(
      "Hi",
      await fakeDeps({ "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] }),
    );
    expect(plain.traceUrl).toBeUndefined();
  });
});

describe("closing the tracing (#1324f)", () => {
  it("an owned adapter is flushed, then shut down — once, with its application's last workflow", async () => {
    const calls: string[] = [];
    const adapter = adapterOf(calls);
    const owner = {};
    const first = await tracingOf(adapter, undefined, { workflow: "first", owner });
    const second = await tracingOf(adapter, undefined, { workflow: "second", owner });

    await first?.close();
    expect(calls).toEqual(["forceFlush"]);
    await second?.close();
    // a second close of the same workflow changes nothing
    await second?.close();

    expect(calls).toEqual(["forceFlush", "forceFlush", "shutdown"]);
  });

  it("a caller's TracerProvider is only flushed: the caller shuts it down", async () => {
    const provider = new CountingProvider();
    const tracing = await tracingOf(provider, undefined, { workflow: "w", owner: {} });

    await tracing?.close();

    expect(provider.calls).toEqual(["forceFlush"]);
  });

  it("a provider that cannot flush (the API's bare TracerProvider) closes without error", async () => {
    const inner = new BasicTracerProvider();
    const bare: TracerProvider = { getTracer: (name) => inner.getTracer(name) };
    const tracing = await tracingOf(bare, undefined, { workflow: "w", owner: {} });

    await expect(tracing?.close()).resolves.toBeUndefined();
  });
});
