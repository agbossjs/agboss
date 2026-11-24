import type { Usd } from "../units/index.js";
import { usd } from "../units/index.js";

/** What a call was for — the cost categories of a turn. */
export enum CostCategory {
  Agents = "agents",
  Routing = "routing",
  Guardrails = "guardrails",
  Review = "review",
  Tools = "tools",
  Memory = "memory",
  Rag = "rag",
  Files = "files",
  Pii = "pii",
  Arbiters = "arbiters",
  Pauses = "pauses",
}

/**
 * The category of each caller prefix, longest first (`router:quality:` before `router:`): the one
 * table `costCategoryOf` reads. A caller with none of these prefixes is an agent's own name.
 */
const CATEGORY_BY_PREFIX: readonly (readonly [string, CostCategory])[] = [
  ["router:quality:", CostCategory.Review],
  ["router:", CostCategory.Routing],
  ["judge:", CostCategory.Review],
  ["tool:", CostCategory.Tools],
  ["action:", CostCategory.Tools],
  ["memory:", CostCategory.Memory],
  ["compaction:", CostCategory.Memory],
  ["rag:", CostCategory.Rag],
  ["reranker:", CostCategory.Rag],
  ["files:", CostCategory.Files],
  ["file-masker:", CostCategory.Files],
  ["file-transcriber:", CostCategory.Files],
  ["guardrail:", CostCategory.Guardrails],
  ["pii:", CostCategory.Pii],
  ["arbiter:", CostCategory.Arbiters],
  ["channel-interpreter:", CostCategory.Pauses],
  ["reply-interpreter:", CostCategory.Pauses],
];

/**
 * Category from the caller name: `tool:*` and `action:*` (tools), `memory:*` (memory), `rag:*` and
 * `reranker:*` (rag), `pii:*` (pii), `files:*`, `file-masker:*` and `file-transcriber:*` (files),
 * `arbiter:*` (arbiters), `channel-interpreter:*` (pauses), `guardrail:*` (guardrails),
 * `router:quality:*` and `judge:*` (review), other `router:*` (routing); an agent's own name.
 */
export function costCategoryOf(caller: string): CostCategory {
  for (const [prefix, category] of CATEGORY_BY_PREFIX)
    if (caller.startsWith(prefix)) return category;
  return CostCategory.Agents;
}

/** Every category at nothing: what a cost report starts from. */
export const NO_COST_BY_CATEGORY: Readonly<Record<CostCategory, Usd>> = {
  [CostCategory.Agents]: usd(0),
  [CostCategory.Routing]: usd(0),
  [CostCategory.Guardrails]: usd(0),
  [CostCategory.Review]: usd(0),
  [CostCategory.Tools]: usd(0),
  [CostCategory.Memory]: usd(0),
  [CostCategory.Rag]: usd(0),
  [CostCategory.Files]: usd(0),
  [CostCategory.Pii]: usd(0),
  [CostCategory.Arbiters]: usd(0),
  [CostCategory.Pauses]: usd(0),
};
