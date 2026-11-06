/** What a call was for — the cost categories of a turn. */
export enum CostCategory {
  Agents = "agents",
  Routing = "routing",
  Guards = "guards",
  Review = "review",
  Tools = "tools",
  Compaction = "compaction",
  Retrieval = "retrieval",
}

/** Category from the caller name: tool:* and action:* (tools), compaction:*, guardrail:* (guards), router:quality:* and judge:* (review), other router:*, agent. */
export function costCategoryOf(caller: string): CostCategory {
  if (caller.startsWith("judge:")) return CostCategory.Review;
  if (caller.startsWith("tool:") || caller.startsWith("action:")) return CostCategory.Tools;
  if (caller.startsWith("compaction:")) return CostCategory.Compaction;
  if (caller.startsWith("rag:")) return CostCategory.Retrieval;
  if (caller.startsWith("guardrail:")) return CostCategory.Guards;
  if (caller.startsWith("router:quality:")) return CostCategory.Review;
  if (caller.startsWith("router:")) return CostCategory.Routing;
  return CostCategory.Agents;
}
