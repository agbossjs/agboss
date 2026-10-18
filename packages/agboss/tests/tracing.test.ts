import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackHandler } from "@langfuse/langchain";
import { describe, expect, it } from "vitest";
import { langfuseTracing } from "../src/tracing/langfuse.js";
import { tracingOf, type RunTracing, type TraceContext } from "../src/tracing/index.js";
import { routeTo, fakeDeps, runText } from "./helpers.js";

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

describe("tracing", () => {
  it("is off without Langfuse settings", () => {
    expect(langfuseTracing({})).toBeUndefined();
    expect(
      langfuseTracing({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }),
    ).toBeUndefined();
  });

  it("tracingOf loads Langfuse only when it is configured (#195)", async () => {
    await expect(tracingOf({ LANGFUSE_PUBLIC_KEY: "pk" })).resolves.toBeUndefined();
    const tracing = await tracingOf({
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: "http://localhost:3000",
      LANGFUSE_PROJECT_ID: "p1",
    });
    expect(tracing?.sessionUrl("t1")).toBe("http://localhost:3000/project/p1/sessions/t1");
    await tracing?.shutdown();
  });

  it("with settings: one Langfuse handler per run, session = thread, tag = bundle", async () => {
    const tracing = langfuseTracing({
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_BASE_URL: "http://127.0.0.1:9",
    });

    const [handler] =
      tracing?.callbacks({
        bundle: "job-scout",
        threadId: "t-1",
        runId: "r-1",
        tenantId: "acme",
      }) ?? [];

    expect(handler).toBeInstanceOf(CallbackHandler);
    expect(handler).toMatchObject({ sessionId: "t-1", tags: ["job-scout", "tenant:acme"] });
    expect(tracing?.sessionUrl("t-1")).toBeUndefined();
    await tracing?.shutdown();
  });

  it("passes the callbacks to the graph run with the thread and run ids", async () => {
    const recorder = new NodeRecorder();
    const seen: TraceContext[] = [];
    const tracing: RunTracing = {
      callbacks: (context) => {
        seen.push(context);
        return [recorder];
      },
      sessionUrl: (threadId) => `http://traces/sessions/${threadId}`,
      shutdown: () => Promise.resolve(),
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

  it("links the conversation when the project id is known, and has no link without tracing", async () => {
    const tracing = langfuseTracing({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "http://localhost:3000/",
      LANGFUSE_PROJECT_ID: "my project",
    });

    expect(tracing?.sessionUrl("t 1")).toBe(
      "http://localhost:3000/project/my%20project/sessions/t%201",
    );
    await tracing?.shutdown();
    const plain = await runText(
      "Hi",
      await fakeDeps({ "test/router": [routeTo("alpha-agent")], "test/alpha": ["ok"] }),
    );
    expect(plain.traceUrl).toBeUndefined();
  });
});
