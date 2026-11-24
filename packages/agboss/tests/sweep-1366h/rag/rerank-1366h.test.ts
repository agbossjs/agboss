/**
 * #1366: a reranking is checked and traced as its contract says: more than topK results, a passage that is no
 * candidate or one given twice fail it (the retrieval's own first topK on a fallback, the error of FailStep
 * with its facts); an empty retrieval calls no reranker; a code reranker's call is not masked; an aborted call
 * stays aborted; the spans hold what the reranker was asked and why it fell back.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { describe, expect, it, vi } from "vitest";
import { withModelReading, type ModelReadingMask } from "../../../src/pii/model-boundary.js";
import {
  RerankFailedError,
  rerankedRetrieval,
  type BoundReranker,
  type RerankCall,
} from "../../../src/rag/rerank.js";
import { RerankFailurePolicy, type RerankerHandler } from "../../../src/rag/types.js";

AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());

const A = { source: "a.md", text: "alpha", score: 0.9 };
const B = { source: "b.md", text: "beta", score: 0.8 };
const C = { source: "c.md", text: "gamma", score: 0.7 };

const retrieve = (results: readonly (typeof A)[] = [A, B, C]) =>
  vi.fn(() => Promise.resolve({ results, costUsd: 0.5 }));
const callOf = (topK: number, signal = new AbortController().signal): RerankCall => ({
  query: "q",
  topK,
  tenantId: "t",
  signal,
});

const bound = (
  handler: RerankerHandler,
  onFailure = RerankFailurePolicy.Fallback,
): BoundReranker => ({
  rag: "docs",
  reranker: "docs-reranker",
  candidates: 3,
  onFailure,
  source: { kind: "code", instance: () => handler },
});

const returning = (results: readonly { source: string; text: string }[]): RerankerHandler => ({
  rerank: () => Promise.resolve({ results }),
});

describe("#1366: a reranking that breaks its contract fails", () => {
  const broken: readonly [string, readonly { source: string; text: string }[], number][] = [
    ["more results than topK", [B, A], 1],
    ["a passage that is no candidate", [{ source: "x.md", text: "alpha" }], 2],
    ["the same candidate twice", [A, A], 2],
  ];

  it.each(broken)(
    "%s: on the fallback the retrieval's own first topK",
    async (_, results, topK) => {
      const found = await rerankedRetrieval(retrieve(), bound(returning(results)), callOf(topK));

      expect(found.results).toEqual([A, B, C].slice(0, topK));
    },
  );

  it.each(broken)(
    "%s: under FailStep the step's error, its cause an invalid reranking",
    async (_, results, topK) => {
      const failed = await rerankedRetrieval(
        retrieve(),
        bound(returning(results), RerankFailurePolicy.FailStep),
        callOf(topK),
      ).catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(RerankFailedError);
      expect(failed).toMatchObject({
        code: "step.rerank-failed",
        rag: "docs",
        reranker: "docs-reranker",
        details: { rag: "docs", reranker: "docs-reranker" },
      });
      expect((failed as Error).cause).toMatchObject({ name: "InvalidRerankingError" });
    },
  );

  it("a candidate is told by its source and its text together", async () => {
    const sameSource = { source: "a.md", text: "other text" };

    const found = await rerankedRetrieval(retrieve(), bound(returning([sameSource])), callOf(2));

    expect(found.results).toEqual([A, B]);
  });

  it("distinct candidates up to topK are let through in the reranker's order", async () => {
    const found = await rerankedRetrieval(retrieve(), bound(returning([C, A])), callOf(2));

    expect(found.results).toEqual([C, A]);
    expect(found.costUsd).toBe(0.5);
  });
});

describe("#1366: when the reranker is called", () => {
  it("an empty retrieval is returned as it is and calls no reranker", async () => {
    const rerank = vi.fn(() => Promise.resolve({ results: [] }));
    const empty = { results: [], costUsd: 0.25 };

    const found = await rerankedRetrieval(
      () => Promise.resolve(empty),
      bound({ rerank }),
      callOf(2),
    );

    expect(found).toBe(empty);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("a code reranker's candidates are not masked even where an agent's reading is set", async () => {
    const reading = vi.fn<ModelReadingMask>(() =>
      Promise.resolve({ texts: [], tokens: {}, usage: [] }),
    );

    const found = await withModelReading(reading, () =>
      rerankedRetrieval(retrieve(), bound(returning([A])), callOf(2)),
    );

    expect(reading).not.toHaveBeenCalled();
    expect(found.usage).toEqual([]);
  });

  it("an aborted call stays aborted: the reranker's own error comes out, with no fallback", async () => {
    const controller = new AbortController();
    const boom = new Error("aborted by caller");
    const handler: RerankerHandler = {
      rerank: () => {
        controller.abort();
        return Promise.reject(boom);
      },
    };

    const outcome = await rerankedRetrieval(
      retrieve(),
      bound(handler),
      callOf(2, controller.signal),
    ).catch((error: unknown) => error);

    expect(outcome).toBe(boom);
  });
});

describe("#1366: the spans of a reranking", () => {
  interface Span {
    readonly name: string;
    readonly inputs: unknown;
    outputs?: unknown;
  }

  /** Runs `work` under a parent and returns the `rerank:` spans it made. */
  async function spansOf(work: () => Promise<unknown>): Promise<Span[]> {
    const spans = new Map<string, Span>();
    class Recorder extends BaseCallbackHandler {
      name = "recorder";
      override handleChainStart(
        ...args: Parameters<NonNullable<BaseCallbackHandler["handleChainStart"]>>
      ): void {
        const name = args[7];
        if (name?.startsWith("rerank:") === true) spans.set(args[2], { name, inputs: args[1] });
      }
      override handleChainEnd(
        ...args: Parameters<NonNullable<BaseCallbackHandler["handleChainEnd"]>>
      ): void {
        const span = spans.get(args[1]);
        if (span !== undefined) span.outputs = args[0];
      }
    }
    await AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: [new Recorder()] }, work);
    return [...spans.values()];
  }

  it("the rerank span holds the query and the sources asked", async () => {
    const spans = await spansOf(() =>
      rerankedRetrieval(retrieve([A, B]), bound(returning([A])), callOf(2)),
    );

    expect(spans.map((span) => span.name)).toEqual(["rerank:docs"]);
    expect(spans[0]?.inputs).toEqual({ query: "q", candidates: ["a.md", "b.md"] });
  });

  it("a fallback span holds the reason, as its input and its output", async () => {
    const failing: RerankerHandler = { rerank: () => Promise.reject(new Error("reranker down")) };

    const spans = await spansOf(() => rerankedRetrieval(retrieve(), bound(failing), callOf(2)));

    const fallback = spans.find((span) => span.name === "rerank:docs:fallback");
    expect(fallback?.inputs).toEqual({ reason: "reranker down" });
    expect(fallback?.outputs).toEqual({ reason: "reranker down" });
  });
});
