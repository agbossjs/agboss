/**
 * #1324f at the application: `createApp({ tracerProvider })` — a caller's provider or an adapter —
 * what `app.close()` does to each, `traceUrl` on a finished, a paused and a cancelled output, and
 * that no processor of the provider ever holds a PII value, at its start or at its end.
 */
import type { Context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { cancelledOutputOf } from "../../src/app/cancelled-output.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { tracingOf, type TracingAdapter } from "../../src/tracing/index.js";
import { ExecutionStatus } from "../../src/index.js";
import { execute } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ContactPiiPolicy,
  OpenWorkflow,
  PII_KEY_VARIABLE,
  PiiAppStorage,
  PiiStart,
  PiiWorkflow,
} from "../pii/pii.fixture.js";
import {
  ListingApplication,
  managerFlow,
  resetAsked,
} from "../flow/fixtures/list-pauses.fixture.js";

/** pii-workflow lists the employee-id policy; open-workflow lists none: two workflows in one application. */
@Application({
  name: "pii-traced-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PiiWorkflow, OpenWorkflow],
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
  storage: PiiAppStorage,
})
class PiiTracedApplication {}

const EMPLOYEE_ID = "EMP-0042";
const env = { [PII_KEY_VARIABLE]: "test-key", PII_APP_KEY: "app-key" };

/** What a processor sees of a span at its start and at its end. */
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

/** A provider that tells what was done to it. */
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

const scripted = (): ScriptBook => {
  const book = new ScriptBook();
  book.scriptOf("agent:support-agent").thenReturn(replyWith(`checked ${EMPLOYEE_ID}`));
  return book;
};

describe("#1324f: no PII reaches an external provider's processors", () => {
  it("a spy processor sees the span at its start and at its end: never the raw value", async () => {
    const spy = new SpyProcessor();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [spy, new SimpleSpanProcessor(exporter)],
    });
    const app = await createTestAppWith(PiiTracedApplication, {
      processEnv: env,
      tracerProvider: provider,
      gateway: createScriptedGateway(scripted()),
    });

    await execute(app, PiiStart, { text: `about ${EMPLOYEE_ID}` });
    await app.close();

    expect(spy.seen.length).toBeGreaterThan(6);
    expect(spy.seen.join("\n")).toContain("<employee-id>");
    expect(spy.seen.join("\n")).not.toContain(EMPLOYEE_ID);
    expect(
      JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes)),
    ).not.toContain(EMPLOYEE_ID);
  });
});

describe("#1324f: what app.close() does to the tracing", () => {
  it("a caller's TracerProvider is flushed, never shut down", async () => {
    const provider = new CountingProvider();
    const app = await createTestAppWith(PiiTracedApplication, {
      processEnv: env,
      tracerProvider: provider,
      gateway: createScriptedGateway(scripted()),
    });

    await execute(app, PiiStart, { text: "hello" });
    await app.close();

    // the application has two workflows: each flushes when it stops, none shuts the provider down
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(new Set(provider.calls)).toEqual(new Set(["forceFlush"]));
  });

  it("an adapter is flushed and shut down — once, whatever the number of workflows — and links every output", async () => {
    const calls: string[] = [];
    const adapter: TracingAdapter = {
      tracerProvider: new BasicTracerProvider(),
      traceUrl: (ctx) => `http://traces/${ctx.workflow}/${ctx.threadId}/${ctx.runId}`,
      forceFlush: () => {
        calls.push("forceFlush");
        return Promise.resolve();
      },
      shutdown: () => {
        calls.push("shutdown");
        return Promise.resolve();
      },
    };
    const app = await createTestAppWith(PiiTracedApplication, {
      processEnv: env,
      tracerProvider: adapter,
      gateway: createScriptedGateway(scripted()),
    });

    const result = await execute(app, PiiStart, { text: "hello" });
    await app.close();

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.traceUrl).toBe(
      `http://traces/pii-workflow/${result.threadId}/${result.executionId}`,
    );
    expect(calls.filter((call) => call === "shutdown")).toEqual(["shutdown"]);
    expect(calls.at(-1)).toBe("shutdown");
    expect(calls).toContain("forceFlush");
  });

  it("without tracing there is no link, and no tracing is built", async () => {
    const app = await createTestAppWith(PiiTracedApplication, {
      processEnv: env,
      gateway: createScriptedGateway(scripted()),
    });

    const result = await execute(app, PiiStart, { text: "hello" });
    await app.close();

    expect(result.traceUrl).toBeUndefined();
  });
});

describe("#1324f: traceUrl on a paused and a cancelled output", () => {
  it("a paused execution carries the adapter's link", async () => {
    resetAsked();
    const adapter: TracingAdapter = {
      tracerProvider: new BasicTracerProvider(),
      traceUrl: (ctx) => `http://traces/${ctx.workflow}/${ctx.threadId}`,
    };
    const app = await createTestAppWith(ListingApplication, { tracerProvider: adapter });

    const paused = await execute(
      app,
      managerFlow.start,
      { orderId: "a", note: "n" },
      { threadId: "pt-1" },
    );
    await app.close();

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.traceUrl).toBe("http://traces/list-manager-workflow/pt-1");
  });

  it("a cancelled execution carries it too, even when its checkpoint cannot be read", async () => {
    const tracing = await tracingOf(
      {
        tracerProvider: new BasicTracerProvider(),
        traceUrl: (ctx) =>
          `http://traces/${ctx.workflow}/${ctx.threadId}/${ctx.runId}/${ctx.tenantId}`,
      },
      undefined,
      { workflow: "w", owner: {} },
    );
    const deps = { tracing, config: { name: "w" }, log: { warn: () => undefined } };
    const state = { threadId: "t-9", tenantId: "acme", runId: "run-9" };

    const output = await cancelledOutputOf(deps as never, state as never, {
      cause: new Error("cancelled"),
    });

    expect(output.status).toBe(ExecutionStatus.Cancelled);
    expect(output.traceUrl).toBe("http://traces/w/t-9/run-9/acme");
    await tracing?.close();
  });
});
