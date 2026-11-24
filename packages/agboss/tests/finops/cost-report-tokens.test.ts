import { describe, expect, it } from "vitest";
import {
  CostCategory,
  costCategoryOf,
  CostReport,
  CostSource,
  totalTokens,
  type UsageRecord,
} from "../../src/finops/usage.js";
import { usd } from "../../src/units/index.js";

/**
 * #1318b: a report carries tokens beside dollars, `CostReport.empty/sum/fromUsage` build it, every
 * caller prefix has its category, and an unpriced call (a CLI or local model: $0, real tokens) is a
 * call with tokens in the report.
 */

const call = (
  caller: string,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  cost = 0,
  costSource: CostSource = CostSource.Api,
): UsageRecord => ({
  caller,
  model: "m",
  inputTokens: tokens.input,
  outputTokens: tokens.output,
  cacheReadTokens: tokens.cacheRead ?? 0,
  cacheWriteTokens: tokens.cacheWrite ?? 0,
  costUsd: usd(cost),
  costSource,
});

describe("costCategoryOf: every caller prefix has a category", () => {
  it.each([
    ["memory:summary", CostCategory.Memory],
    ["compaction:summary", CostCategory.Memory],
    ["rag:docs", CostCategory.Rag],
    ["reranker:docs", CostCategory.Rag],
    ["pii:cards", CostCategory.Pii],
    ["files:transcriber", CostCategory.Files],
    ["file-masker:scans", CostCategory.Files],
    ["file-transcriber:scans", CostCategory.Files],
    ["arbiter:quorum", CostCategory.Arbiters],
    ["channel-interpreter:mail", CostCategory.Pauses],
    ["reply-interpreter:mail", CostCategory.Pauses],
    ["guardrail:injection", CostCategory.Guardrails],
    ["judge:quality", CostCategory.Review],
    ["router:quality:main", CostCategory.Review],
    ["router:main", CostCategory.Routing],
    ["tool:search", CostCategory.Tools],
    ["action:charge", CostCategory.Tools],
    ["buyer-agent", CostCategory.Agents],
  ])("%s is %s", (caller, category) => {
    expect(costCategoryOf(caller)).toBe(category);
  });

  it("names every CostCategory in a report's byCategory, at usd(0) when unused", () => {
    expect(Object.keys(CostReport.empty().byCategory).sort()).toEqual(
      Object.values(CostCategory).sort(),
    );
  });
});

describe("CostReport tokens", () => {
  it("sums input, output, cache and total tokens of the known calls", () => {
    const report = CostReport.fromUsage([
      call("a", { input: 100, output: 20, cacheRead: 60, cacheWrite: 10 }, 0.5),
      call("b", { input: 40, output: 5 }, 0.25),
    ]);
    expect(report).toMatchObject({
      inputTokens: 140,
      outputTokens: 25,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      totalTokens: 165,
      totalUsd: 0.75,
      calls: 2,
    });
  });

  it("counts a $0 call with tokens: an unpriced call is a call with tokens, not nothing", () => {
    const report = CostReport.fromUsage([
      call("cli-agent", { input: 900, output: 100 }, 0, CostSource.Unpriced),
    ]);
    expect(report.totalUsd).toBe(0);
    expect(report.calls).toBe(1);
    expect(report.totalTokens).toBe(1000);
    expect(report.trace[0]?.costSource).toBe(CostSource.Unpriced);
  });

  it("keeps a lost pass (#853) out of the calls and the tokens", () => {
    const lost: UsageRecord = {
      ...call("lost-pass:w", { input: 0, output: 0 }),
      costSource: CostSource.Unknown,
    };
    const report = CostReport.fromUsage([lost, call("a", { input: 1, output: 2 })]);
    expect(report).toMatchObject({ calls: 1, unknownCalls: 1, totalTokens: 3 });
  });

  it("empty() is the report of no calls", () => {
    expect(CostReport.empty()).toEqual(CostReport.fromUsage([]));
    expect(CostReport.empty()).toMatchObject({ totalUsd: 0, calls: 0, totalTokens: 0, trace: [] });
  });

  it("sum() is the report of every call of the reports, in order", () => {
    const first = CostReport.fromUsage([call("a", { input: 10, output: 1 }, 0.1)]);
    const second = CostReport.fromUsage([
      call("b", { input: 20, output: 2 }, 0, CostSource.Unpriced),
    ]);
    const both = CostReport.sum([first, second]);
    expect(both.trace.map((line) => line.caller)).toEqual(["a", "b"]);
    expect(both).toMatchObject({ totalUsd: 0.1, calls: 2, totalTokens: 33 });
    expect(CostReport.sum([])).toEqual(CostReport.empty());
  });

  it("totalTokens(records) is input plus output, never the cache's tokens again", () => {
    expect(totalTokens([call("a", { input: 100, output: 5, cacheRead: 100 })])).toBe(105);
  });
});
