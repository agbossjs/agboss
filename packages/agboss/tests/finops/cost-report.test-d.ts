import { describe, expectTypeOf, it } from "vitest";
import {
  CostCategory,
  CostReport,
  type CostLine,
  type UsageRecord,
} from "../../src/finops/usage.js";
import type { Usd } from "../../src/units/index.js";

declare const report: CostReport;
declare const record: UsageRecord;
declare const line: CostLine;

describe("#1318b: every monetary field is Usd", () => {
  it("a report, a line and a usage record carry Usd", () => {
    expectTypeOf(report.totalUsd).toEqualTypeOf<Usd>();
    expectTypeOf(report.byCaller).toEqualTypeOf<Readonly<Record<string, Usd>>>();
    expectTypeOf(report.byModel).toEqualTypeOf<Readonly<Record<string, Usd>>>();
    expectTypeOf(report.byCategory).toEqualTypeOf<Readonly<Record<CostCategory, Usd>>>();
    expectTypeOf(line.costUsd).toEqualTypeOf<Usd>();
    expectTypeOf(record.costUsd).toEqualTypeOf<Usd>();
  });

  it("a plain number is no cost", () => {
    // @ts-expect-error -- costUsd is Usd, never a bare number
    const bare: UsageRecord = { ...record, costUsd: 0.5 };
    expectTypeOf(bare).toEqualTypeOf<UsageRecord>();
  });

  it("a report carries tokens", () => {
    expectTypeOf(report.inputTokens).toEqualTypeOf<number>();
    expectTypeOf(report.outputTokens).toEqualTypeOf<number>();
    expectTypeOf(report.cacheReadTokens).toEqualTypeOf<number>();
    expectTypeOf(report.cacheWriteTokens).toEqualTypeOf<number>();
    expectTypeOf(report.totalTokens).toEqualTypeOf<number>();
  });

  it("the old categories are gone", () => {
    expectTypeOf<typeof CostCategory>().not.toHaveProperty("Guards");
    expectTypeOf<typeof CostCategory>().not.toHaveProperty("Compaction");
    expectTypeOf<typeof CostCategory>().not.toHaveProperty("Retrieval");
    expectTypeOf<typeof CostCategory>().toHaveProperty("Guardrails");
    expectTypeOf<typeof CostCategory>().toHaveProperty("Memory");
    expectTypeOf<typeof CostCategory>().toHaveProperty("Rag");
  });

  it("the builders return a report", () => {
    expectTypeOf(CostReport.empty()).toEqualTypeOf<CostReport>();
    expectTypeOf(CostReport.sum([report])).toEqualTypeOf<CostReport>();
    expectTypeOf(CostReport.fromUsage([record])).toEqualTypeOf<CostReport>();
  });
});
