import { NodeKind } from "../flow/ast.js";
import { isThisWorkflow } from "../flow/this-workflow.js";
import type { GraphDeps } from "../graph/deps.js";
import { NO_OBSERVABILITY_MASK, type ObservabilityMask } from "../pii/observability-mask.js";

/**
 * A tree's record masked part by part (#1150): the root's own fields by the root's mask, each child
 * execution's record — with its pauses — by its own chain's (application ∪ root ∪ … ∪ parent ∪
 * child), never by the root's alone, so a policy only a child lists never leaks upward through the
 * root's `result.record`, its history or its pause answers. A child is found by its workflow's name
 * below its parent's deps (the parent's `childDepsOf`, chained); one not found is masked by every
 * workflow of the tree in turn (fail closed).
 */

/** A child's record as the tree's record nests it. */
interface ChildNode {
  readonly executionId: string;
  readonly workflow: { readonly name: string };
  readonly children: readonly ChildNode[];
}

/** One entry of the tree's lists that belongs to an execution (a pause's answer, an outbound call). */
interface OwnedEntry {
  readonly executionId: string;
}

/** How a mask is applied: `value` (a result's record) or `traceData` (a kept history record). */
export type MaskUse = "value" | "traceData";

/** What a tree's masks are found from: a workflow's deps and, through them, its children's. */
export type TreeDeps = Pick<GraphDeps<string>, "pii" | "graph" | "childDepsOf" | "config">;

/** The deps of `parent`'s child workflow `name`: its own under `parent`'s chain. */
function childNamed(parent: TreeDeps, name: string): TreeDeps | undefined {
  for (const node of parent.graph.nodes.values()) {
    if (node.kind !== NodeKind.Workflow) continue;
    if (isThisWorkflow(node.component)) {
      if (parent.config.name === name) return parent;
      continue;
    }
    const child = parent.childDepsOf?.(node.component);
    if (child?.config.name === name) return child;
  }
  return undefined;
}

/** Every workflow's mask of the tree below `deps`, each once. */
function treeMasksOf(deps: TreeDeps): readonly ObservabilityMask[] {
  const masks: ObservabilityMask[] = [];
  const seen = new Set<TreeDeps>();
  const visit = (at: TreeDeps): void => {
    if (seen.has(at)) return;
    seen.add(at);
    // no policies: still no file bytes (#899 §0)
    masks.push(at.pii?.observability ?? NO_OBSERVABILITY_MASK);
    for (const node of at.graph.nodes.values()) {
      if (node.kind !== NodeKind.Workflow || isThisWorkflow(node.component)) continue;
      const child = at.childDepsOf?.(node.component);
      if (child !== undefined) visit(child);
    }
  };
  visit(deps);
  return masks;
}

/** Masks applied one after another: the union of what each masks (fail closed). */
const allOf = (masks: readonly ObservabilityMask[]): ObservabilityMask => ({
  value: async (data) => {
    let shown = data;
    for (const mask of masks) shown = await mask.value(shown);
    return shown;
  },
  text: (line) => masks.reduce((shown, mask) => mask.text(shown), line),
  traceData: async (data) => {
    let shown = data;
    for (const mask of masks) shown = await mask.traceData(shown);
    return shown;
  },
});

/** The mask of each child execution of the tree by its id; `fallback` for one not found. */
export interface TreeMasks {
  readonly of: (executionId: string) => ObservabilityMask;
}

/** The masks of a tree's executions: the root's own, each child's by its chain. */
export function treeMasksFor(
  deps: TreeDeps,
  rootExecutionId: string,
  children: readonly ChildNode[],
): TreeMasks {
  const own = deps.pii?.observability ?? NO_OBSERVABILITY_MASK;
  const byId = new Map<string, ObservabilityMask>();
  let fallback: ObservabilityMask | undefined;
  const fallbackMask = (): ObservabilityMask => (fallback ??= allOf(treeMasksOf(deps)));
  const walk = (nodes: readonly ChildNode[], parent: TreeDeps | undefined): void => {
    for (const node of nodes) {
      const child = parent === undefined ? undefined : childNamed(parent, node.workflow.name);
      byId.set(
        node.executionId,
        child === undefined ? fallbackMask() : (child.pii?.observability ?? NO_OBSERVABILITY_MASK),
      );
      walk(node.children, child);
    }
  };
  walk(children, deps);
  return {
    of: (executionId) =>
      executionId === rootExecutionId ? own : (byId.get(executionId) ?? fallbackMask()),
  };
}

const apply = (mask: ObservabilityMask, use: MaskUse, data: unknown): Promise<unknown> =>
  use === "value" ? mask.value(data) : mask.traceData(data);

/** A child's record and its own children's, each by its own mask. */
async function maskedChild<T extends ChildNode>(
  child: T,
  masks: TreeMasks,
  use: MaskUse,
): Promise<T> {
  const own = (await apply(masks.of(child.executionId), use, { ...child, children: [] })) as T;
  const children: ChildNode[] = [];
  for (const each of child.children) children.push(await maskedChild(each, masks, use));
  return { ...own, children };
}

/** Each entry by the mask of the execution it belongs to. */
export async function maskedEntries<T extends OwnedEntry>(
  entries: readonly T[],
  masks: TreeMasks,
  use: MaskUse,
): Promise<T[]> {
  const shown: T[] = [];
  for (const entry of entries)
    shown.push((await apply(masks.of(entry.executionId), use, entry)) as T);
  return shown;
}

/** What a tree's record has: its children, and the tree's own lists by execution. */
interface TreeRecord {
  readonly children: readonly ChildNode[];
  readonly pauses?: readonly OwnedEntry[];
  readonly outboundCalls?: readonly OwnedEntry[];
}

/**
 * The tree's record masked part by part: its own fields by the root's mask, each child's by its
 * chain's, each pause answer and outbound call by its execution's.
 */
export async function maskedTreeRecordOf<T extends TreeRecord>(
  record: T,
  masks: TreeMasks,
  rootExecutionId: string,
  use: MaskUse,
): Promise<T> {
  const { pauses, outboundCalls } = record;
  const rest = {
    ...record,
    children: [],
    ...(pauses === undefined ? {} : { pauses: [] }),
    ...(outboundCalls === undefined ? {} : { outboundCalls: [] }),
  };
  const own = (await apply(masks.of(rootExecutionId), use, rest)) as T;
  const children: ChildNode[] = [];
  for (const child of record.children) children.push(await maskedChild(child, masks, use));
  return {
    ...own,
    children,
    ...(pauses === undefined ? {} : { pauses: await maskedEntries(pauses, masks, use) }),
    ...(outboundCalls === undefined
      ? {}
      : { outboundCalls: await maskedEntries(outboundCalls, masks, use) }),
  };
}

/** Every workflow's deps of the tree below `deps` with a node `nodeId`, each way once. */
function withNode(deps: TreeDeps, nodeId: string): readonly TreeDeps[] {
  const found: TreeDeps[] = [];
  const seen = new Set<TreeDeps>();
  const visit = (at: TreeDeps): void => {
    if (seen.has(at)) return;
    seen.add(at);
    if (at.graph.nodes.has(nodeId)) found.push(at);
    for (const node of at.graph.nodes.values()) {
      if (node.kind !== NodeKind.Workflow || isThisWorkflow(node.component)) continue;
      const child = at.childDepsOf?.(node.component);
      if (child !== undefined) visit(child);
    }
  };
  visit(deps);
  return found;
}

/**
 * The pending pauses as the root's pause event shows them: a child's (its `childExecutionId`) also
 * masked by the chain of the workflow its step belongs to — every way to it, the whole tree's for
 * a step not found (fail closed); the root's event mask covers the rest.
 */
export async function maskedPendingOf<
  T extends { readonly childExecutionId: string | undefined; readonly step: string },
>(deps: TreeDeps, pending: readonly T[]): Promise<T[]> {
  const shown: T[] = [];
  for (const pause of pending) {
    if (pause.childExecutionId === undefined || deps.pii === undefined) {
      shown.push(pause);
      continue;
    }
    const owners = withNode(deps, pause.step.split("#")[0] ?? pause.step);
    const masks = owners.flatMap((owner) =>
      owner.pii === undefined ? [] : [owner.pii.observability],
    );
    const mask = masks.length === 0 ? allOf(treeMasksOf(deps)) : allOf(masks);
    shown.push((await mask.value(pause)) as T);
  }
  return shown;
}
