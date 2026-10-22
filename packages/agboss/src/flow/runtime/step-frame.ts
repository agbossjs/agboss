import type { RunnableConfig } from "@langchain/core/runnables";
import { ExecutionCancelledError } from "../../core/errors.js";
import { extractRunContext } from "../../core/run-context.js";
import { NodeKind } from "../ast.js";
import {
  declaredMaxConcurrentExecutionsOf,
  maxConcurrentExecutionsOf,
} from "../decorators/workflow.js";
import type { SlotClaim, SubtreeCap, TreeSlotRegistry } from "./launch/launch-registry.js";
import type { QueueWatch, SlotHold } from "./launch/slot-queue.js";
import type { WorkflowDescriptor } from "../context/execution-context.js";
import {
  currentFrame,
  executionsFromRootOf,
  type ExecutionFacts,
  type FrameSpec,
} from "../context/frame.js";
import { tenantOfExecution, type RuntimeContexts } from "../context/runtime-contexts.js";
import { idempotencyKeyOf } from "../context/idempotency.js";
import type { RuntimeGraph, RuntimeNode } from "./graph-model.js";
import type { ExecutionStateType } from "./state.js";
import type { ComponentRecord } from "./records.js";
import { componentKindOf } from "./join-keys.js";
import { recordOfComponent } from "./workflow-keys.js";

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

/** What a step's frame is made with: its workflow, the context levels, its components' records. */
export interface StepFrameDeps {
  /** The workflow, for the step's `ExecutionContext` (#280). */
  readonly workflow: WorkflowIdentity;
  /** The application's context levels (#261), for the step's tenant. */
  readonly contexts: RuntimeContexts;
  /** Every component's record with its join keys (#268 S93), by `name`. */
  readonly components: ReadonlyMap<string, ComponentRecord>;
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
  deps: StepFrameDeps,
): FrameSpec {
  const site = { node, visitNumber: visitNumberOf(node, state) };
  return stepFrameAt(site, state, config, deps);
}

/** The frame of a visit at `site`: a branch's has its copy id, copy number and item (#273). */
export function stepFrameAt(
  site: StepSite,
  state: ExecutionStateType,
  config: RunnableConfig | undefined,
  { workflow, contexts, components }: StepFrameDeps,
): FrameSpec {
  const { run } = extractRunContext(config, state.runId);
  const executionId: string = run.runId;
  const { node, visitNumber, itemIndex } = site;
  const nodeId = site.nodeId ?? node.id;
  const record = recordOfComponent(components, node.id, componentKindOf(node.kind));
  const step = {
    component: Object.freeze({ type: node.component, ...record }),
    nodeId,
    visitNumber,
    idempotencyKey: idempotencyKeyOf({ executionId, nodeId, visitNumber, itemIndex }),
    callId: undefined,
    itemIndex,
    copyNumber: site.copyNumber ?? 1,
    toolLoopIteration: undefined,
    validationAttempts: 0,
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

/**
 * A step's claim on its tree's slots (#264 S27): a step that works — an agent, a router, an action,
 * a branch of a launch too — of any execution of the tree takes one; a start and a finish only mark
 * where an execution begins and ends, and a child workflow's node waits for its child (the child's
 * own steps take theirs). The claim names the execution, its depth, whether it closes a branch (its
 * step comes right after its child, or its children's join) and the subtrees whose own, smaller cap
 * it counts in.
 */

/** Whether a visit of the node works in a slot of its tree. */
const takesSlot = (node: RuntimeNode): boolean =>
  node.kind === NodeKind.Agent || node.kind === NodeKind.Router || node.kind === NodeKind.Action;

/** The subtrees below the root whose own cap is smaller than every cap around them. */
function subtreesOf(line: readonly ExecutionFacts[], treeCap: number): readonly SubtreeCap[] {
  const subtrees: SubtreeCap[] = [];
  let enclosing = treeCap;
  for (const member of line.slice(1)) {
    const own = declaredMaxConcurrentExecutionsOf(member.workflow.type);
    if (own === undefined || own >= enclosing) continue;
    subtrees.push({ executionId: member.executionId, maxConcurrentExecutions: own });
    enclosing = own;
  }
  return subtrees;
}

/** Whether the step comes right after its execution's child, or its children's join. */
function closesBranch(graph: RuntimeGraph, state: ExecutionStateType): boolean {
  const previous = state.path.at(-1);
  return previous !== undefined && graph.nodes.get(previous)?.kind === NodeKind.Workflow;
}

/** Where a step takes its tree slot. */
export interface TreeSlotSite {
  readonly slots: TreeSlotRegistry | undefined;
  readonly graph: RuntimeGraph;
  readonly node: RuntimeNode;
  readonly state: ExecutionStateType;
  readonly config: RunnableConfig | undefined;
  /** The step's execution: its frame's. */
  readonly execution: ExecutionFacts;
  /** A quorum's deadline, told when the step waits (#279). */
  readonly watch?: QueueWatch;
}

/** A step's claim, the root of its tree and the tree's cap. */
interface TreeClaim {
  readonly root: ExecutionFacts;
  readonly cap: number;
  readonly claim: SlotClaim;
}

/** The step's claim and the tree it is on. */
function claimAt(site: TreeSlotSite): TreeClaim {
  const line = executionsFromRootOf(site.execution);
  const root = line[0] ?? site.execution;
  const cap = maxConcurrentExecutionsOf(root.workflow.type);
  const claim: SlotClaim = {
    executionId: site.execution.executionId,
    depth: line.length,
    closesBranch: closesBranch(site.graph, site.state),
    subtrees: subtreesOf(line, cap),
  };
  return { root, cap, claim };
}

/** A wait the execution's signal ended (a cancel, its launch's `FailFast`, the instance's stop). */
const cancelledWaiting = (what: string): ExecutionCancelledError =>
  new ExecutionCancelledError(`the execution was cancelled waiting for ${what}`);

/**
 * The step's slots: its tree's (#264), then — when the application caps them — one of its
 * instance's (#332), with the same claim; a quorum's deadline excludes both waits (#279).
 */
async function takeSlots(site: TreeSlotSite, slots: TreeSlotRegistry): Promise<SlotHold> {
  const { root, cap, claim } = claimAt(site);
  const { clock } = extractRunContext(site.config, site.state.runId);
  const { signal } = site.execution;
  const tree = await slots.slotsOf(root.executionId, cap, clock).take(claim, signal, site.watch);
  if (tree === undefined) throw cancelledWaiting("a tree slot");
  if (slots.instance === undefined) return tree;
  const step = await slots.instance.take(claim, signal, site.watch);
  if (step !== undefined) {
    return {
      release: (): void => {
        step.release();
        tree.release();
      },
    };
  }
  tree.release();
  throw cancelledWaiting("a step slot of the instance");
}

/**
 * Runs one step's `work` in a slot of its tree and of its instance: waits in the queue while either
 * is at its cap, releases both when the work ends, fails or pauses. A wait the execution's signal
 * ends (a cancel, its launch's `FailFast` abort) throws `ExecutionCancelledError`, the work never run.
 */
export async function inTreeSlot<TResult>(
  site: TreeSlotSite,
  work: () => Promise<TResult>,
): Promise<TResult> {
  if (site.slots === undefined || !takesSlot(site.node)) return work();
  const hold = await takeSlots(site, site.slots);
  try {
    return await work();
  } finally {
    hold.release();
  }
}
