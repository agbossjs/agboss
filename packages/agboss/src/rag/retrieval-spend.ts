import { recordReportedCost, type UsageRecord } from "../finops/usage.js";
import type { KnowledgeRetrieval } from "./types.js";

/**
 * A retrieval's spend under `rag:<name>`: the source's reported cost and tokens (none when it was
 * free), then the reranker's own records. A zero record is no record.
 */
export function retrievalRecordsOf(name: string, retrieval: KnowledgeRetrieval): UsageRecord[] {
  const cost = retrieval.costUsd ?? 0;
  const tokens = retrieval.tokens ?? 0;
  const own: UsageRecord[] =
    cost === 0 && tokens === 0
      ? []
      : [{ ...recordReportedCost({ name, costCaller: `rag:${name}` }, cost), inputTokens: tokens }];
  return [...own, ...(retrieval.usage ?? [])];
}
