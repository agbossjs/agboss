/** What a call was for — the cost categories of a turn. */
export enum CostCategory {
  Agents = "agents",
  Routing = "routing",
  Guards = "guards",
  Review = "review",
  Tools = "tools",
  Compaction = "compaction",
  Retrieval = "retrieval",
  Files = "files",
}

/** Category from the caller name: tool:* and action:* (tools), compaction:*, guardrail:* (guards), router:quality:* and judge:* (review), other router:*, agent. */
export function costCategoryOf(caller: string): CostCategory {
  if (caller.startsWith("judge:")) return CostCategory.Review;
  if (caller.startsWith("tool:") || caller.startsWith("action:")) return CostCategory.Tools;
  if (caller.startsWith("compaction:")) return CostCategory.Compaction;
  if (caller.startsWith("rag:")) return CostCategory.Retrieval;
  if (caller.startsWith("files:")) return CostCategory.Files;
  if (caller.startsWith("guardrail:")) return CostCategory.Guards;
  if (caller.startsWith("router:quality:")) return CostCategory.Review;
  if (caller.startsWith("router:")) return CostCategory.Routing;
  return CostCategory.Agents;
}

/** Every category at nothing: what a cost report starts from. */
export const NO_COST_BY_CATEGORY: Readonly<Record<CostCategory, number>> = {
  [CostCategory.Agents]: 0,
  [CostCategory.Routing]: 0,
  [CostCategory.Guards]: 0,
  [CostCategory.Review]: 0,
  [CostCategory.Tools]: 0,
  [CostCategory.Compaction]: 0,
  [CostCategory.Retrieval]: 0,
  [CostCategory.Files]: 0,
};
