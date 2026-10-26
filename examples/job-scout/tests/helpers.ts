import type { UsageRecord } from "@agboss/core";

/** A usage record for fake router outcomes. */
export const usageRecord = (caller: string, costUsd: number): UsageRecord => ({
  caller,
  model: "test/m",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: "price-table",
});
