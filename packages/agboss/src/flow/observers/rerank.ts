import type { Usd } from "../../units/index.js";
import type { NodeEvent } from "./execution-event.js";

/**
 * A knowledge base's reranker starts (#1299, `onRerankStart`): the retrieval returned `candidates`
 * passages and the `@RagReranker` orders them for the best `topK`. Names and counts only, never the
 * query or a passage. An empty retrieval calls no reranker, so it has no event.
 */
export interface RerankStartEvent extends NodeEvent {
  /** The `@Rag`'s name. */
  readonly rag: string;
  /** The `@RagReranker`'s name. */
  readonly reranker: string;
  /** How many passages the retrieval returned for it to order. */
  readonly candidates: number;
  readonly topK: number;
}

/** How a reranking ended. */
export enum RerankOutcome {
  /** The reranker's order is the agent's. */
  Reranked = "reranked",
  /** It failed under `RerankFailurePolicy.Fallback`: the retrieval's own first `topK` go on. */
  FellBack = "fell-back",
  /** It failed under `RerankFailurePolicy.FailStep`: the step fails (`StepError.RerankFailed`). */
  Failed = "failed",
}

/** A reranker ended (`onRerankEnd`): once per `onRerankStart`, with what it spent. */
export interface RerankEndEvent extends RerankStartEvent {
  readonly outcome: RerankOutcome;
  /** How many passages go on to the agent. */
  readonly results: number;
  /** What the reranker spent (`0` for a code reranker that reports none); the spend is already counted. */
  readonly costUsd: Usd;
}
