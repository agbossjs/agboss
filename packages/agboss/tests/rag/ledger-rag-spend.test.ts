import { usd } from "../../src/units/index.js";
/**
 * #1366 (ledger-retention shard) — the spend of a knowledge base's `search()`, each rule on its own:
 * its own cost and tokens and a reranker's records reported to the call's frame under their own
 * callers (`rag:<name>`, `reranker:<name>`), a free search reporting nothing, a paid one outside a
 * step failing closed, never twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentFrame } from "../../src/flow/context/frame.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { bindRagRuntime, RagSource, type RagRuntime } from "../../src/rag/rag-source.js";
import { retrievalRecordsOf } from "../../src/rag/retrieval-spend.js";
import { SpendOutsideStepError } from "../../src/components/spend-recorder.js";

vi.mock("../../src/flow/context/frame.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/context/frame.js")>()),
  currentFrame: vi.fn(),
}));

const record = (costUsd: number, caller = "reranker:docs-reranker"): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

class Docs extends RagSource {
  protected override retrieve(): never {
    throw new Error("the pipeline is the only way in");
  }
}

/** A source whose pipeline gives `retrieval`. */
const sourceOf = (retrieval: unknown) => {
  const retrieve = vi.fn((_query: string, _options: unknown) => Promise.resolve(retrieval));
  const source = new Docs();
  const runtime: unknown = { name: "docs-rag", topK: 3, retrieve };
  bindRagRuntime(source, runtime as RagRuntime);
  return { source, retrieve };
};

const frameOf = (reportUsage?: (record: UsageRecord) => void) =>
  ({
    isClosed: () => false,
    execution: { tenant: { tenantId: "tenant-1" }, signal: new AbortController().signal },
    services: { reportUsage },
  }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(currentFrame).mockReturnValue(frameOf());
});

describe("#1366: a knowledge base's search spend", () => {
  it("answers the pipeline's results only: no cost, tokens or usage leak into the output", async () => {
    const { source, retrieve } = sourceOf({
      results: [{ source: "a.md", text: "A", score: 0.5 }],
      costUsd: usd(0.25),
      tokens: 40,
      usage: [record(0.5)],
    });
    vi.mocked(currentFrame).mockReturnValue(frameOf(vi.fn()));

    const out = await source.search("q", { topK: 2 });

    expect(out).toEqual({ results: [{ source: "a.md", text: "A", score: 0.5 }] });
    expect(retrieve).toHaveBeenCalledWith("q", { topK: 2, signal: expect.any(AbortSignal) });
  });

  it("the call's topK defaults to the @Rag's, and a filter goes through as it is", async () => {
    const { source, retrieve } = sourceOf({ results: [] });

    await source.search("q");
    await source.search("q", { filter: { lang: "en" } } as never);

    expect(retrieve.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { topK: 3, signal: expect.any(AbortSignal) },
      { topK: 3, signal: expect.any(AbortSignal), filter: { lang: "en" } },
    ]);
  });

  it("reports the retrieval's cost and tokens to the call's frame under rag:<name>, then the reranker's records", async () => {
    const reportUsage = vi.fn();
    vi.mocked(currentFrame).mockReturnValue(frameOf(reportUsage));
    const { source } = sourceOf({
      results: [],
      costUsd: usd(0.125),
      tokens: 40,
      usage: [record(0.5), record(0.25)],
    });

    await source.search("q");

    expect(
      (reportUsage.mock.calls as [UsageRecord][]).map(([spent]) => [
        spent.caller,
        spent.costUsd,
        spent.inputTokens,
      ]),
    ).toEqual([
      ["rag:docs-rag", 0.125, 40],
      ["reranker:docs-reranker", 0.5, 0],
      ["reranker:docs-reranker", 0.25, 0],
    ]);
  });

  it("a free search reports nothing, with or without a frame to report to", async () => {
    const reportUsage = vi.fn();
    vi.mocked(currentFrame).mockReturnValue(frameOf(reportUsage));
    await sourceOf({ results: [], costUsd: usd(0) }).source.search("q");
    vi.mocked(currentFrame).mockReturnValue(frameOf());

    await expect(sourceOf({ results: [] }).source.search("q")).resolves.toEqual({ results: [] });

    expect(reportUsage).not.toHaveBeenCalled();
  });

  it("tokens alone are spend: a custom embedding source counts toward maxTokens", () => {
    expect(
      retrievalRecordsOf("docs-rag", { results: [], tokens: 12 }).map((r) => [
        r.caller,
        r.costUsd,
        r.inputTokens,
      ]),
    ).toEqual([["rag:docs-rag", 0, 12]]);
  });

  it("a paid search with no frame to report to fails closed: spend.outside-step, never a free read", async () => {
    const { source } = sourceOf({ results: [], costUsd: usd(0.25) });

    await expect(source.search("q")).rejects.toBeInstanceOf(SpendOutsideStepError);
  });

  it("outside any step: context.unavailable, the pipeline is never called", async () => {
    vi.mocked(currentFrame).mockReturnValue(undefined);
    const { source, retrieve } = sourceOf({ results: [] });

    await expect(source.search("q")).rejects.toThrow(/outside an execution/u);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("an instance the application did not create has no pipeline: it fails, it never reads", async () => {
    await expect(new Docs().search("q")).rejects.toThrow(/did not create/u);
  });
});
