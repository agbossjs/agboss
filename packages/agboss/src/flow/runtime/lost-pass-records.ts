import type { RunnableConfig } from "@langchain/core/runnables";
import { lostTokensOfTask, unknownCostRecordsOf } from "../../finops/lost-passes.js";
import type { UsageRecord } from "../../finops/usage.js";
import { extractRunContext } from "../../core/run-context.js";
import { NodeKind } from "../ast.js";
import type { FrameServices } from "../context/frame.js";
import { isCodeRouterNode, type RuntimeNode } from "./graph-model.js";
import type { BranchFrameRun } from "./launch/branch-view.js";
import { countedServiceSpend } from "./limits.js";

/** A step whose visit calls a model: an agent's loop, a router decided by its model. */
const callsModel = (node: RuntimeNode): boolean =>
  node.kind === NodeKind.Agent || (node.kind === NodeKind.Router && !isCodeRouterNode(node));

/** The step a visit records its lost passes for: its node, its id on the path, its task. */
export interface LostPassSite {
  readonly node: RuntimeNode;
  /** The node's id on the path: a copy's own (`critic-agent#2`). */
  readonly nodeId: string;
  readonly config: RunnableConfig | undefined;
  /** The execution's id: its run's clock dates the records. */
  readonly runId: string;
  readonly services: Pick<FrameServices, "reportUsage"> | undefined;
}

/**
 * The lost passes of a visit's step, recorded before it runs again (#853): only in the first
 * superstep of a pass that took the tree over, for a step whose task no lost pass finished — one
 * record of unknown cost each, tallied (written to the ledger at once, under the lost pass's own
 * id) and kept with the visit's spend. Nothing on any other visit.
 */
export function recordLostPasses(site: LostPassSite): void {
  if (!callsModel(site.node)) return;
  const { taskId, lost } = lostTokensOfTask(site.config);
  if (lost === undefined) return;
  const step = { nodeId: site.nodeId, taskId, caller: `${site.node.kind}:${site.nodeId}` };
  const now = extractRunContext(site.config, site.runId).clock.now();
  for (const record of unknownCostRecordsOf(lost, step, now)) site.services?.reportUsage?.(record);
}

/**
 * A branch's lost passes (#853), recorded as its run begins — before its quorum and its slot, so a
 * branch cancelled before it runs keeps them in its spend too.
 */
export function recordBranchLostPasses(run: BranchFrameRun): void {
  const reportUsage = (record: UsageRecord): void => {
    run.services.push(countedServiceSpend(run.deps.limits, run.node, run.state.path, record));
  };
  const { node, config, ticket, state } = run;
  recordLostPasses({
    node,
    nodeId: ticket.nodeId,
    config,
    runId: state.runId,
    services: { reportUsage },
  });
}
