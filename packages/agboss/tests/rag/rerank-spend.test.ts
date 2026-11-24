import { usd } from "../../src/units/index.js";
/**
 * #1366: what a rerank costs, whether it works or fails — the spend of its masking, of a model's reply it could
 * not read and of a code reranker's reported cost is on the retrieval it falls back to and on the error of
 * `FailStep`, each under the caller that made it (`reranker:<name>`, `pii:<policy>`; both in the rag category),
 * so no paid call is lost between the reranker and the ledger.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { withModelReading, type ModelReadingMask } from "../../src/pii/model-boundary.js";
import { RerankReplyError } from "../../src/rag/llm-reranker.js";
import { rerankedRetrieval, type BoundReranker } from "../../src/rag/rerank.js";
import { RerankFailurePolicy, type RerankerHandler } from "../../src/rag/types.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const CANDIDATES = [
  { source: "a.md", text: "alpha", score: 0.9 },
  { source: "b.md", text: "beta", score: 0.8 },
];

const retrieve = () => Promise.resolve({ results: CANDIDATES, costUsd: usd(0.0625) });
const call = { query: "q", topK: 1, scopeId: "t", signal: new AbortController().signal };

const codeBound = (
  handler: RerankerHandler,
  onFailure = RerankFailurePolicy.FailStep,
): BoundReranker => ({
  rag: "docs",
  reranker: "docs-reranker",
  candidates: 2,
  onFailure,
  source: { kind: "code", instance: () => handler },
});

/** A model reranker whose model answers `text` at `cost`. */
const modelBound = (text: string, cost: number, onFailure: RerankFailurePolicy): BoundReranker => ({
  rag: "docs",
  reranker: "docs-reranker",
  candidates: 2,
  onFailure,
  source: {
    kind: "model",
    binding: () =>
      ({
        settings: { model: "m" },
        model: {
          invoke: () =>
            Promise.resolve(
              new AIMessage({ content: text, response_metadata: { usage: { cost } } }),
            ),
        },
      }) as never,
  },
});

/** A reading whose masking of each text costs a record. */
const costingReading: ModelReadingMask = (texts) =>
  Promise.resolve({
    texts,
    tokens: {},
    usage: [record(0.5, "mask")],
  });

const callers = (records: readonly UsageRecord[] | undefined): string[] | undefined =>
  records?.map((each) => each.caller);

describe("#1366: the spend of a rerank that works", () => {
  it("a code reranker's reported cost is one record under reranker:<name>", async () => {
    const handler: RerankerHandler = {
      rerank: () => Promise.resolve({ results: CANDIDATES.slice(1), costUsd: usd(0.125) }),
    };

    const found = await rerankedRetrieval(retrieve, codeBound(handler), call);

    expect(found.usage).toMatchObject([{ costUsd: usd(0.125), caller: "reranker:docs-reranker" }]);
    expect(found.costUsd).toBe(0.0625);
  });
});

describe("#1366: the spend of a model reranker that works", () => {
  it("its masking and its call are one record each, each under its own caller, the masking first", async () => {
    const found = await withModelReading(costingReading, () =>
      rerankedRetrieval(
        retrieve,
        modelBound('{"ranking":[2,1]}', 0.75, RerankFailurePolicy.FailStep),
        call,
      ),
    );

    expect(found.results.map((result) => result.source)).toEqual(["b.md"]);
    expect(found.usage?.map((each) => [each.caller, each.costUsd])).toEqual([
      ["mask", 0.5],
      ["reranker:docs-reranker", 0.75],
    ]);
  });
});

describe("#1366: the spend of a rerank that fails", () => {
  const unreadable = codeBoundThrowing();

  function codeBoundThrowing(): RerankerHandler {
    return {
      rerank: () => Promise.reject(new RerankReplyError("no ranking", [record(0.25, "reranker")])),
    };
  }

  it("on the fallback the reply's spend is on the retrieval, under the caller that made it", async () => {
    const found = await rerankedRetrieval(
      retrieve,
      codeBound(unreadable, RerankFailurePolicy.Fallback),
      call,
    );

    expect(found.results).toEqual([CANDIDATES[0]]);
    expect(callers(found.usage)).toEqual(["reranker"]);
    expect(found.usage?.[0]?.costUsd).toBe(0.25);
  });

  it("under FailStep it is on the error", async () => {
    const failed = await rerankedRetrieval(
      retrieve,
      codeBound(unreadable, RerankFailurePolicy.FailStep),
      call,
    ).catch((error: unknown) => error);

    expect(failed).toMatchObject({ code: "step.rerank-failed" });
    expect((failed as { usage: UsageRecord[] }).usage.map((each) => each.costUsd)).toEqual([0.25]);
  });

  it("a model reranker's masking and its unreadable reply are both on it, the masking first", async () => {
    const failed = await withModelReading(costingReading, () =>
      rerankedRetrieval(
        retrieve,
        modelBound("no ranking here", 0.75, RerankFailurePolicy.FailStep),
        call,
      ),
    ).catch((error: unknown) => error);

    expect((failed as { usage: UsageRecord[] }).usage.map((each) => each.costUsd)).toEqual([
      0.5, 0.75,
    ]);
  });
});
