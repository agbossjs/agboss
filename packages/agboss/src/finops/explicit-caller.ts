import type { UsageRecord } from "./usage.js";

/** The callers a service names itself: a knowledge base's search, its reranker, a PII policy's model. */
const EXPLICIT_PREFIXES = ["rag:", "reranker:", "pii:"] as const;

/**
 * The caller of a spend reported inside a step or a tool call: the one the service named
 * (`rag:<name>`, `reranker:<name>`, `pii:<policy>`), else `fallback` (`tool:<name>`, `action:<name>`).
 * What a knowledge base and its reranker spend stays in the rag category wherever it is searched from.
 */
export const callerOfSpend = (record: UsageRecord, fallback: string): string =>
  EXPLICIT_PREFIXES.some((prefix) => record.caller.startsWith(prefix)) ? record.caller : fallback;
