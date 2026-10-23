import type { BudgetCheck } from "../../budgets/execution-budgets.js";
import type { MeshCallServices, ToolCallRemote } from "../../mesh/mesh-call.js";

/** A tool call's mesh services and the remote execution it reported, once it ended. */
export interface ToolMeshCall {
  readonly services: MeshCallServices;
  readonly remote: () => ToolCallRemote | undefined;
}

/**
 * The mesh services of one tool call (#398 PR 2): its tool, the execution's budget left, the end
 * of its `timeout` (sooner when the execution's deadline is) and where its remote execution goes —
 * the first one a trusted peer reported.
 */
export function toolMeshCallOf(
  tool: { readonly name: string; readonly timeout: number },
  budgets: BudgetCheck,
  startedAt: Date,
): ToolMeshCall {
  let remote: ToolCallRemote | undefined;
  const timeoutAt = startedAt.getTime() + tool.timeout;
  const deadline = budgets.deadline === undefined ? Infinity : Date.parse(budgets.deadline.at);
  const services: MeshCallServices = {
    tool: tool.name,
    remainingBudget: () => {
      const left = budgets.remaining?.();
      return left === undefined || !Number.isFinite(left) ? undefined : left;
    },
    deadlineAt: new Date(Math.min(timeoutAt, deadline)),
    recordRemote: (reported) => {
      remote ??= reported;
    },
  };
  return { services, remote: () => remote };
}
