import { handedOverOf, recordedHandOver } from "../../../app/handed-over.js";
import type { Class } from "../../../components/injection.js";
import type { GraphDeps } from "../../../graph/deps.js";
import { HandOverSite } from "../../../infrastructure/execution-audit-log.repository.js";
import { NodeKind } from "../../ast.js";
import { hasUndoableActions } from "../../compensation.js";
import { CompensationEntryStatus, type CompensationEntry } from "../../compensation.js";
import { rootFactsOf, type FrameSpec } from "../../context/frame.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import type { RuntimeGraph } from "../graph-model.js";
import { joinKeysOf, workflowIdentityOf } from "../workflow-keys.js";
import type { CompensationParts } from "./registry.js";
import type { UndoSite } from "./undo.js";

/**
 * A child's undoable actions bubble up to its parent (#1281b, D8): a child that reaches its finish
 * commits none of its open entries — its finish moves them to its parent (`heldBy`), in the same
 * write as the finish itself, and the parent's step that ran the child takes them into its own
 * state (`childPath`: its node of the child first; a branch's launch and index), by their
 * compensation keys — so a retry after a crash neither loses nor doubles one. From then on the
 * parent's finish commits them like its own, and an unwind of the parent (a failed join, a quorum
 * that went on without the child's branch, the parent's own failure, the tree's) undoes them, newest
 * first with its own, in the child's workflow (its graph and container). What the child committed
 * or undid never moves.
 */

/** The execution whose state holds the entry: the one that moved it up, else its own. */
export const holderOf = (entry: CompensationEntry): string => entry.heldBy ?? entry.executionId;

/**
 * Whether a child's unwind covers an entry: one it opened (moved up or not: its parent never took
 * it, the child failed), or one its own children's finishes moved up to it.
 */
export const isChildsEntry = (entry: CompensationEntry, executionId: string): boolean =>
  entry.executionId === executionId || entry.heldBy === executionId;

/** Whether an entry is one its holder's own workflow opened (not moved up from a child). */
export const isOwnEntry = (entry: CompensationEntry): boolean => entry.childPath === undefined;

/**
 * What a child's finish writes of its open entries: each moved to its parent, out of the child's
 * launches (they ended with the child). Their status stays open: the parent commits or undoes them.
 */
export function movedToParent(
  open: readonly CompensationEntry[],
  parentExecutionId: string,
): readonly CompensationEntry[] {
  return open.map((entry) => {
    const moved: { -readonly [K in keyof CompensationEntry]: CompensationEntry[K] } = {
      ...entry,
      heldBy: parentExecutionId,
    };
    delete moved.launchId;
    delete moved.branchIndex;
    return moved;
  });
}

/**
 * The entries the parent's step takes from a child that finished: the open ones its finish moved to
 * this parent, under the parent's node of the child (prefixed once — always from the child's own
 * state, so a step run again after a crash makes the same entries).
 */
export function takenFromChild(
  childEntries: readonly CompensationEntry[],
  parentExecutionId: string,
  node: string,
): readonly CompensationEntry[] {
  return childEntries
    .filter(
      (entry) =>
        entry.status === CompensationEntryStatus.Open && entry.heldBy === parentExecutionId,
    )
    .map((entry) => ({ ...entry, childPath: [node, ...(entry.childPath ?? [])] }));
}

/** The taken entries as a branch of the parent's launch holds them: undone by its join. */
export const inBranch = (
  entries: readonly CompensationEntry[],
  branch: { readonly launchId: string; readonly branchIndex: number },
): readonly CompensationEntry[] =>
  entries.map((entry) => ({
    ...entry,
    launchId: branch.launchId,
    branchIndex: branch.branchIndex,
  }));

/**
 * The parent applies the move only while it holds its tree (#471): a holder past its lease applies
 * nothing — the step is handed over, the new holder runs it again and takes them itself.
 */
export function assertTaking(frame: FrameSpec): void {
  try {
    frame.execution.lease?.assertHeld();
  } catch (error) {
    const handedOver = handedOverOf(error, frame.execution.signal);
    if (handedOver !== undefined) throw recordedHandOver(handedOver, HandOverSite.Child, frame);
    throw error;
  }
}

/** The tree a step's frame runs in: where its entries are mirrored. */
export const treeOfFrame = ({ execution }: FrameSpec): ExecutionTree => ({
  tenantId: execution.tenant.tenantId,
  rootExecutionId: rootFactsOf(execution).executionId,
});

/** What a step took from its child's finish, and where: its branch, the instance's registry. */
export interface TakenSite {
  readonly taken: readonly CompensationEntry[] | undefined;
  /** A child workflow's branch: stamped on each, so its join undoes them. */
  readonly branch?: { readonly launchId: string; readonly branchIndex: number };
  readonly parts: CompensationParts | undefined;
  readonly frame: FrameSpec;
}

/**
 * A step's entries with the ones its child's finish moved up (#1281b), first: mirrored in the
 * instance's registry the moment the step has them; the step's own as they are when there are none.
 */
export function withTaken<TOwn extends { readonly compensations?: readonly CompensationEntry[] }>(
  site: TakenSite,
  own: TOwn,
): TOwn | { readonly compensations: CompensationEntry[] } {
  const found = site.taken ?? [];
  if (found.length === 0) return own;
  const taken = site.branch === undefined ? found : inBranch(found, site.branch);
  site.parts?.registry.write(treeOfFrame(site.frame), taken);
  return { compensations: [...taken, ...(own.compensations ?? [])] };
}

/**
 * What the parent's step that ran a child takes of the child's finished state (its node of the
 * child): under the parent's lease, or nothing.
 */
export function takenBy(
  frame: FrameSpec,
  node: string,
  child: { readonly compensations: readonly CompensationEntry[] },
): { readonly compensations?: readonly CompensationEntry[] } {
  const moved = takenFromChild(child.compensations, frame.execution.executionId, node);
  if (moved.length === 0) return {};
  // a fenced parent takes nothing: the holder that runs the step again takes them
  assertTaking(frame);
  return { compensations: moved };
}

/** Where the deps of a workflow's children come from. */
export interface ChildDepsSource {
  readonly graph: RuntimeGraph;
  readonly childDepsOf?: ((workflow: Class) => GraphDeps<string> | undefined) | undefined;
}

/** A recursion (#264): the child is the parent's own workflow. */
const SAME = Symbol("same workflow");

/** The deps of the child workflow a parent's node runs; `SAME` for a recursion. */
function childOf(deps: ChildDepsSource, node: string): GraphDeps<string> | typeof SAME | undefined {
  const found = deps.graph.nodes.get(node);
  if (found?.kind !== NodeKind.Workflow) return undefined;
  if (found.component === deps.graph.type) return SAME;
  return deps.childDepsOf?.(found.component);
}

/** Whether a workflow, or a child of it at any depth, declares an undo: only then can it hold one. */
export function canHoldEntries(deps: ChildDepsSource, seen = new Set<RuntimeGraph>()): boolean {
  if (seen.has(deps.graph)) return false;
  seen.add(deps.graph);
  if (hasUndoableActions(deps.graph)) return true;
  return [...deps.graph.nodes.values()].some((node) => {
    const child = childOf(deps, node.id);
    return child !== undefined && child !== SAME && canHoldEntries(child, seen);
  });
}

/** Whether a launched node can leave an entry to its join: an undoable action, a child that can hold one. */
export function canLeaveEntries(deps: ChildDepsSource, node: string): boolean {
  const { declaration } = deps.graph.nodes.get(node) ?? {};
  if (declaration?.kind === NodeKind.Action)
    return declaration.options.compensateWith !== undefined;
  const child = childOf(deps, node);
  if (child === SAME) return hasUndoableActions(deps.graph);
  return child !== undefined && canHoldEntries(child);
}

/**
 * Where a held entry undoes: its own execution in its own workflow — the holder's site for one of
 * its own, else down the holder's nodes of the children (`childPath`) to the workflow that opened
 * it. A path that names no child workflow fails closed: nothing is undone in the wrong workflow.
 */
export function heldUndoSiteOf(
  holder: UndoSite,
  deps: ChildDepsSource,
  entry: CompensationEntry,
): UndoSite {
  const path = entry.childPath;
  if (path === undefined) return holder;
  let current: ChildDepsSource = deps;
  let own: GraphDeps<string> | undefined;
  for (const node of path) {
    const child = childOf(current, node);
    if (child === undefined)
      throw new TypeError(`${node} is no child workflow to undo ${entry.action} in`);
    if (child !== SAME) {
      own = child;
      current = child;
    }
  }
  const workflow =
    own === undefined
      ? holder.execution.workflow
      : Object.freeze({
          ...workflowIdentityOf(own),
          startedVersion: workflowIdentityOf(own).version,
        });
  const execution = Object.freeze({
    ...holder.execution,
    executionId: entry.executionId,
    workflow,
  });
  if (own === undefined) return { ...holder, execution };
  const graph = { graph: own.graph, container: own.container };
  return { ...holder, ...graph, components: joinKeysOf(own).components, execution };
}
