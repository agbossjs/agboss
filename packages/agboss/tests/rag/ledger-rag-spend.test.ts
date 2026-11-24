/**
 * #1366 (ledger-retention shard) — the spend of a knowledge base's search tool, each rule on its own: its own cost
 * and a reranker's records reported to the call (into its frame when there is one, else as a cost), never twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchTool, searchToolName } from "../../src/components/rag.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { rerankedRetrieval } from "../../src/rag/rerank.js";

vi.mock("../../src/flow/context/frame.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/context/frame.js")>()),
  currentFrame: vi.fn(),
}));
vi.mock("../../src/rag/rerank.js", () => ({ rerankedRetrieval: vi.fn() }));

const record = (costUsd: number): UsageRecord => ({
  ...ZERO_USAGE,
  caller: "rag:docs-rag",
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const meta = { name: "docs-rag", description: "The docs", topK: 3 } as never;

const toolOf = (retrieval: unknown, reranker?: never) => {
  const connector = { retrieve: vi.fn(() => Promise.resolve(retrieval)) };
  return { tool: searchTool(meta, connector as never, reranker), connector };
};

const call = (tool: ReturnType<typeof searchTool>) => {
  const reportCost = vi.fn();
  const signal = new AbortController().signal;
  return { reportCost, signal, run: () => tool.invoke({ query: "q" }, { signal, reportCost }) };
};

const frameOf = (reportUsage?: (record: UsageRecord) => void) =>
  ({
    isClosed: () => false,
    execution: { tenant: { tenantId: "tenant-1" } },
    services: { reportUsage },
  }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(currentFrame).mockReturnValue(frameOf());
});

describe("#1366: a knowledge base's search tool", () => {
  it("is named for the base and billed to `rag:<name>`", () => {
    const { tool } = toolOf({ results: [] });

    expect(searchToolName(meta)).toBe("search-docs-rag-tool");
    expect(tool.name).toBe("search-docs-rag-tool");
    expect(tool.description).toContain("The docs. ");
    expect((tool as { costCaller?: string }).costCaller).toBe("rag:docs-rag");
  });

  it("answers the tenant's retrieval, with the score only where there is one", async () => {
    const { tool, connector } = toolOf({
      results: [
        { source: "a.md", text: "A", score: 0.5 },
        { source: "b.md", text: "B" },
      ],
    });
    const made = call(tool);

    const out = await made.run();

    expect(connector.retrieve).toHaveBeenCalledWith("q", {
      topK: 3,
      signal: expect.any(AbortSignal),
      tenantId: "tenant-1",
    });
    expect(out).toEqual({
      kind: "ok",
      value: {
        results: [
          { source: "a.md", text: "A", score: 0.5 },
          { source: "b.md", text: "B" },
        ],
      },
    });
    expect(Object.keys((out as { value: { results: object[] } }).value.results[1] ?? {})).toEqual([
      "source",
      "text",
    ]);
  });

  it("reports the retrieval's cost to the call, and 0 when the connector gave none", async () => {
    const priced = call(toolOf({ results: [], costUsd: 0.25 }).tool);
    const free = call(toolOf({ results: [] }).tool);

    await priced.run();
    await free.run();

    expect(priced.reportCost).toHaveBeenCalledOnce();
    expect(priced.reportCost).toHaveBeenCalledWith(0.25);
    expect(free.reportCost).toHaveBeenCalledOnce();
    expect(free.reportCost).toHaveBeenCalledWith(0);
  });

  it("with a reranker the spend of its records goes into the call's frame, record by record, not as a cost", async () => {
    const reportUsage = vi.fn();
    vi.mocked(currentFrame).mockReturnValue(frameOf(reportUsage));
    vi.mocked(rerankedRetrieval).mockResolvedValue({
      results: [],
      costUsd: 0.125,
      usage: [record(0.5), record(0.25)],
    });
    const made = call(toolOf({ results: [] }, { rag: "docs-rag" } as never).tool);

    await made.run();

    expect(reportUsage.mock.calls).toEqual([[record(0.5)], [record(0.25)]]);
    expect(made.reportCost.mock.calls).toEqual([[0.125]]);
  });

  it("with no frame at all, a reranker's records are reported as costs too", async () => {
    let calls = 0;
    // the tenant is read from a frame (the tool's step entry reads one first); the report finds none
    vi.mocked(currentFrame).mockImplementation(() => (++calls <= 2 ? frameOf() : undefined));
    vi.mocked(rerankedRetrieval).mockResolvedValue({ results: [], usage: [record(0.5)] });
    const made = call(toolOf({ results: [] }, { rag: "docs-rag" } as never).tool);

    await made.run();

    expect(made.reportCost.mock.calls).toEqual([[0], [0.5]]);
  });

  it("with no frame to report to, a reranker's records are reported as costs", async () => {
    vi.mocked(rerankedRetrieval).mockResolvedValue({
      results: [],
      usage: [record(0.5), record(0.25)],
    });
    const made = call(toolOf({ results: [] }, { rag: "docs-rag" } as never).tool);

    await made.run();

    expect(made.reportCost.mock.calls).toEqual([[0], [0.5], [0.25]]);
  });

  it("a retrieval with no reranker records reports no usage", async () => {
    const reportUsage = vi.fn();
    vi.mocked(currentFrame).mockReturnValue(frameOf(reportUsage));
    const made = call(toolOf({ results: [], costUsd: 0.25 }).tool);

    await made.run();

    expect(reportUsage).not.toHaveBeenCalled();
    expect(made.reportCost.mock.calls).toEqual([[0.25]]);
  });
});
