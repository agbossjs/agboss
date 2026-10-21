import { describe, expect, it } from "vitest";
import { memoryLine } from "../../src/cli/approve.js";
import { costSummary, costTotal, costTrace } from "../../src/cli/finops.js";
// the framework's cost report, built the way a run builds it
import { buildCostReport, recordToolCost } from "../../../agboss/src/finops/usage.js";
import { usageRecord } from "../../../agboss/tests/helpers.js";

describe("CLI cost output", () => {
  const report = buildCostReport([
    usageRecord("router:main", 0.00005),
    usageRecord("researcher", 0.003378),
    recordToolCost("exchange_rate", 0.001),
  ]);

  it("lists non-zero categories only", () => {
    expect(costSummary(report)).toBe("agents $0.003378 · routing $0.000050 · tools $0.001000");
    expect(costSummary(buildCostReport([]))).toBe("no paid calls");
  });

  it("ends with an explicit total", () => {
    expect(costTotal(report)).toBe("total $0.004428 (3 calls)");
  });

  it("says how each call was priced", () => {
    const api = buildCostReport([{ ...usageRecord("router:main", 0.00002), costSource: "api" }]);

    expect(costTrace(api)[0]).toMatch(/api-priced$/);
  });

  it("prints one line per call in order", () => {
    const lines = costTrace(report);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ 1\. router:main\s+\S+\s+\$0\.000050\s+\d+ in \/ \d+ out$/);
    expect(lines[2]).toMatch(
      /^ 3\. tool:exchange_rate\s+exchange_rate\s+\$0\.001000\s+tool-reported$/,
    );
  });

  it("AC2 (#77): says when a turn compacted the conversation", () => {
    const compacted = [
      {
        compaction: "conversation-compaction",
        fromTurn: 1,
        toTurn: 5,
        summaries: 1,
        summaryQueueLength: 10,
      },
    ];
    expect(memoryLine({ compacted })).toBe(
      "memory: conversation-compaction turns 1–5 → summary 1/10",
    );
    expect(memoryLine({})).toBeUndefined();
  });
});
