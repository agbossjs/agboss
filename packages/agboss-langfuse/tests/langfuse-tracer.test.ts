import type { TracingAdapter } from "@agboss/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { LangfuseTracer } from "../src/index.js";

const KEYS = { publicKey: "pk-lf-1", secretKey: "sk-lf-1", baseUrl: "http://127.0.0.1:9" };
const LINK = { workflow: "support", threadId: "thread 1", runId: "run-1", tenantId: "acme" };

describe("LangfuseTracer (#1324f)", () => {
  it("is a TracingAdapter of the core", () => {
    const tracer: TracingAdapter = new LangfuseTracer(KEYS);

    expect(typeof tracer.tracerProvider.getTracer).toBe("function");
    expect(typeof tracer.forceFlush).toBe("function");
    expect(typeof tracer.shutdown).toBe("function");
  });

  it("every key is required", () => {
    expect(() => new LangfuseTracer({ ...KEYS, publicKey: "" })).toThrow(/publicKey is required/u);
    expect(() => new LangfuseTracer({ ...KEYS, secretKey: "" })).toThrow(/secretKey is required/u);
    expect(() => new LangfuseTracer({ ...KEYS, baseUrl: "" })).toThrow(/baseUrl is required/u);
  });

  it("links the conversation (session = thread) when the project is known", () => {
    const tracer = new LangfuseTracer({
      ...KEYS,
      baseUrl: "http://localhost:3000/",
      projectId: "my project",
    });

    expect(tracer.traceUrl(LINK)).toBe(
      "http://localhost:3000/project/my%20project/sessions/thread%201",
    );
  });

  it("has no link without a project id", () => {
    expect(new LangfuseTracer(KEYS).traceUrl(LINK)).toBeUndefined();
    expect(new LangfuseTracer({ ...KEYS, projectId: "" }).traceUrl(LINK)).toBeUndefined();
  });

  it("fromEnv reads the Langfuse variables and is undefined unless all three are set", () => {
    expect(LangfuseTracer.fromEnv({})).toBeUndefined();
    expect(
      LangfuseTracer.fromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }),
    ).toBeUndefined();
    const tracer = LangfuseTracer.fromEnv({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "http://localhost:3000",
      LANGFUSE_PROJECT_ID: "p1",
    });

    expect(tracer?.traceUrl(LINK)).toBe("http://localhost:3000/project/p1/sessions/thread%201");
  });

  it("exports what its provider's tracers end, and shuts down once flushed", async () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new LangfuseTracer({ ...KEYS, exporter });

    tracer.tracerProvider.getTracer("@agboss/core").startSpan("step").end();
    // a span of a library nobody told Langfuse about stays out
    tracer.tracerProvider.getTracer("http").startSpan("request").end();
    await tracer.forceFlush();

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["step"]);
    await tracer.shutdown();
  });
});
