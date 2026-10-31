import { isCancelRequested } from "../cancel-requests.js";
import type { Class } from "../../components/injection.js";
import { ExecutionCancelledError } from "../../core/errors.js";
import { NodeKind } from "../../flow/ast.js";
import { isThisWorkflow } from "../../flow/this-workflow.js";
import type { GraphDeps } from "../../graph/deps.js";
import type {
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type { ExecutionTreeRepository } from "../../infrastructure/execution-tree.repository.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { LeaseTakeoverReason } from "../../infrastructure/execution-lease-event.repository.js";
import type { LeaseTake } from "../execution-leases.js";
import type { BuiltApp } from "../create-app.js";

const WATCH_EVERY: Milliseconds = seconds(10);

/** Whether `current` is still the same `Running` claim as `row`. */
export const isSameRunningClaim = (
  current: QueuedChildExecution | undefined,
  row: QueuedChildExecution,
): current is QueuedChildExecution =>
  current?.status === ExecutionRecordStatus.Running &&
  current.claimedAt !== undefined &&
  current.claimedAt.getTime() === row.claimedAt?.getTime();

/**
 * The take of a remote child's own lease (#501): a reclaim takes over a child a worker was running.
 * Over (#520) once the queue row is no longer the claim `row` names — ended, paused, claimed again
 * or removed with its tree: no lease is taken for it, no takeover recorded.
 */
export const childTakeOf = (
  queue: Pick<ChildExecutionQueueRepository, "findByTenantIdAndExecutionId">,
  row: QueuedChildExecution,
  isReclaim: boolean,
): LeaseTake => ({
  reason: LeaseTakeoverReason.RemoteChild,
  isTakeover: isReclaim,
  rootExecutionId: row.rootExecutionId,
  isOver: async () =>
    !isSameRunningClaim(
      await queue.findByTenantIdAndExecutionId(row.tenantId, row.executionId),
      row,
    ),
});

/** Every 10 s while the child runs: its tree cancelled or ended stops it. */
export async function watchRunningChild(
  parts: {
    readonly clock: Clock;
    readonly queue: ChildExecutionQueueRepository;
    readonly trees: ExecutionTreeRepository;
  },
  row: QueuedChildExecution,
  stop: AbortController,
): Promise<void> {
  const { tenantId, executionId, rootExecutionId } = row;
  const tree = { tenantId, rootExecutionId };
  for (;;) {
    await parts.clock.sleep(WATCH_EVERY, stop.signal);
    if (stop.signal.aborted) return;
    const still = await parts.queue
      .findByTenantIdAndExecutionId(tenantId, executionId)
      .catch(() => row);
    if (still === undefined || (await isCancelRequested(parts.trees, tree))) {
      stop.abort(new ExecutionCancelledError("the child's tree was cancelled or ended"));
      return;
    }
  }
}

/**
 * Every workflow an instance can run a queued child of (#333 PR 2): the application's workflows
 * and, at any depth, the children they launch — each by its `name`, with its deps (the same an
 * in-process child runs on) and the application workflow of its tree.
 */
export interface ChildRegistry {
  /** The application's workflow by name: a tree's root. */
  readonly rootOf: (name: string) => BuiltApp | undefined;
  /** A workflow's deps by name. */
  readonly depsOf: (name: string) => GraphDeps<string> | undefined;
  /** The `@Workflow` class of a workflow name. */
  readonly workflowOf: (name: string) => Class | undefined;
  /** The class of a node of a workflow, by its id (`critic-agent#2` → `critic-agent`). */
  readonly componentOf: (workflow: string, nodeId: string) => Class | undefined;
}

/** A copy's node id without its copy number. */
const baseNodeId = (nodeId: string): string => nodeId.split("#")[0] ?? nodeId;

export function childRegistryOf(workflows: readonly BuiltApp[]): ChildRegistry {
  const byName = new Map<string, GraphDeps<string>>();
  const visit = (deps: GraphDeps<string>): void => {
    if (byName.has(deps.config.name)) return;
    byName.set(deps.config.name, deps);
    for (const node of deps.graph.nodes.values()) {
      if (node.kind !== NodeKind.Workflow || isThisWorkflow(node.component)) continue;
      const child = deps.childDepsOf?.(node.component);
      if (child !== undefined) visit(child);
    }
  };
  for (const workflow of workflows) visit(workflow.deps);
  const roots = new Map(workflows.map((workflow) => [workflow.deps.config.name, workflow]));
  return {
    rootOf: (name) => roots.get(name),
    depsOf: (name) => byName.get(name),
    workflowOf: (name) => byName.get(name)?.graph.type,
    componentOf: (workflow, nodeId) =>
      byName.get(workflow)?.graph.nodes.get(baseNodeId(nodeId))?.component,
  };
}
