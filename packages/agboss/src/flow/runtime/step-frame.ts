import type { RunnableConfig } from "@langchain/core/runnables";
import { extractRunContext } from "../../core/run-context.js";
import type { WorkflowDescriptor } from "../context/execution-context.js";
import { currentFrame, type FrameSpec } from "../context/frame.js";
import { tenantOfExecution, type RuntimeContexts } from "../context/runtime-contexts.js";
import { idempotencyKeyOf } from "../context/idempotency.js";
import type { RuntimeNode } from "./graph-model.js";
import type { ExecutionStateType } from "./state.js";

/** The workflow an execution runs, as the runtime knows it before the execution starts. */
export type WorkflowIdentity = Omit<WorkflowDescriptor, "startedVersion">;

/** The version the execution started on: kept in state from its first node, so a resume keeps it. */
export const startedVersionOf = (state: ExecutionStateType, workflow: WorkflowIdentity): string =>
  state.startedVersion === "" ? workflow.version : state.startedVersion;

/** The pass through `node` this visit is, from 1 — the counter `maxVisits` checks (#280 Q43). */
export const visitNumberOf = (node: RuntimeNode, state: ExecutionStateType): number =>
  (state.visits[node.id] ?? 0) + 1;

/** Which visit a frame is for: a node's own, or one branch of a launch (#273) — a copy or an item. */
export interface StepSite {
  readonly node: RuntimeNode;
  readonly visitNumber: number;
  /** `critic-agent#2` for a copy; the node's id otherwise. */
  readonly nodeId?: string;
  readonly copyNumber?: number;
  readonly itemIndex?: number;
}

/**
 * The frame of one visit of `node` (#280): the execution's flat fields from its run, its tenant and
 * its own fields from the state (#261: the values it started with, also after a resume), the step —
 * its component, node id, visit number (the one `maxVisits` counts) and its idempotency key. A
 * resume runs the visit again with the same state, so the same number and key.
 */
export function stepFrameOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  config: RunnableConfig | undefined,
  workflow: WorkflowIdentity,
  contexts: RuntimeContexts,
): FrameSpec {
  const site = { node, visitNumber: visitNumberOf(node, state) };
  return stepFrameAt(site, state, config, workflow, contexts);
}

/** The frame of a visit at `site`: a branch's has its copy id, copy number and item (#273). */
export function stepFrameAt(
  site: StepSite,
  state: ExecutionStateType,
  config: RunnableConfig | undefined,
  workflow: WorkflowIdentity,
  contexts: RuntimeContexts,
): FrameSpec {
  const { run } = extractRunContext(config, state.runId);
  const executionId: string = run.runId;
  const { node, visitNumber, itemIndex } = site;
  const nodeId = site.nodeId ?? node.id;
  const step = {
    component: Object.freeze({ type: node.component, name: node.id }),
    nodeId,
    visitNumber,
    idempotencyKey: idempotencyKeyOf({ executionId, nodeId, visitNumber, itemIndex }),
    callId: undefined,
    itemIndex,
    copyNumber: site.copyNumber ?? 1,
  };
  return {
    execution: Object.freeze({
      executionId,
      threadId: run.threadId,
      ownerId: run.ownerId,
      signal: run.signal,
      workflow: Object.freeze({ ...workflow, startedVersion: startedVersionOf(state, workflow) }),
      tenant: tenantOfExecution(contexts, state.contexts.tenant),
      values: state.contexts.execution,
      // a child execution (#263): its parent's execution and launching step, its item
      ...(run.tree === undefined ? {} : { parent: run.tree.parent, itemIndex: run.tree.itemIndex }),
    }),
    step: Object.freeze(step),
  };
}

/** The node id of the step running now: `critic-agent#2` for a copy of a launch (#273), else the node's. */
export const stepNodeIdOf = (node: RuntimeNode): string => {
  const frame = currentFrame();
  return frame === undefined || frame.isClosed() ? node.id : frame.step.nodeId;
};
