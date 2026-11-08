import type { RunnableConfig } from "@langchain/core/runnables";
import { lostTokensOfTask, unknownCostRecordsOf } from "../../finops/lost-passes.js";
import { NodeKind } from "../ast.js";
import type { FrameServices } from "../context/frame.js";
import { isCodeRouterNode, type RuntimeNode } from "./graph-model.js";

/** A step whose visit calls a model: an agent's loop, a router decided by its model. */
const callsModel = (node: RuntimeNode): boolean =>
  node.kind === NodeKind.Agent || (node.kind === NodeKind.Router && !isCodeRouterNode(node));

/** The step a visit records its lost passes for: its node, its id on the path, its task. */
export interface LostPassSite {
  readonly node: RuntimeNode;
  /** The node's id on the path: a copy's own (`critic-agent#2`). */
  readonly nodeId: string;
  readonly config: RunnableConfig | undefined;
  readonly services: Pick<FrameServices, "reportUsage"> | undefined;
}

/**
 * The lost passes of a visit's step, recorded before it runs again (#853): only in the first
 * superstep of a pass that took the tree over, for a step whose task no lost pass finished — one
 * record of unknown cost each, tallied (written to the ledger at once, under the lost pass's own
 * id) and kept with the visit's spend. Nothing on any other visit.
 */
export function recordLostPasses(site: LostPassSite, now: Date): void {
  if (!callsModel(site.node)) return;
  const { taskId, lost } = lostTokensOfTask(site.config);
  if (lost === undefined) return;
  const step = { nodeId: site.nodeId, taskId, caller: `${site.node.kind}:${site.nodeId}` };
  for (const record of unknownCostRecordsOf(lost, step, now)) site.services?.reportUsage?.(record);
}
