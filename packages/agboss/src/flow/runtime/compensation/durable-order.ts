import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import { undoOf } from "../../analyse/compensation.js";
import type { VisitCompensationSite } from "../../compensation.js";
import { rootFactsOf } from "../../context/frame.js";

/**
 * The order the tree's undoable actions succeeded in, durably (#1281): `CompensationEntry.sequence`
 * is one counter per root tree, across the parent and every child at any depth, written with the
 * entry in the same checkpoint. The registry counts it in process only, so a resume in a fresh
 * process (a takeover, a restart) would start a child's count from nothing and put its entry before
 * its parent's. Each place is claimed in the tree's own store (`saveIfAbsentInTree`: atomic, kept
 * with the tree, visible on any instance), probing upward from what the process and the execution's
 * state know, so two entries of a tree never share a place and a fresh process lands after every
 * place already claimed. An entry moved up from a child keeps the value it was written with.
 */

/** The tree key one place of the order is claimed under. */
export const orderKeyOf = (place: number): string => `@agboss/compensation-order/${String(place)}`;

/** Whether the visit opens an entry: an undoable action that succeeded. */
export const opensEntry = (site: VisitCompensationSite): boolean =>
  site.failure === undefined && undoOf(site.node.component) !== undefined;

const treeOf = ({ frame }: VisitCompensationSite): ExecutionTree => ({
  tenantId: frame.execution.tenant.tenantId,
  rootExecutionId: rootFactsOf(frame.execution).executionId,
});

/**
 * The next free place in the tree's order for the entry this visit opens: after the newest its own
 * state holds and every one this process gave, and not a place another execution of the tree
 * already claimed. A store that fails keeps the in-process place: the entry is never lost.
 */
export async function claimedSequence(site: VisitCompensationSite): Promise<number | undefined> {
  const { parts } = site;
  if (parts === undefined) return undefined;
  const tree = treeOf(site);
  const floor = Math.max(0, ...site.entries.map((entry) => entry.sequence));
  let place = parts.registry.nextSequence(tree, floor);
  const { trees } = parts;
  if (trees === undefined) return place;
  try {
    while (!(await trees.saveIfAbsentInTree(tree, orderKeyOf(place), true))) {
      place = parts.registry.nextSequence(tree, place);
    }
  } catch {
    const text = `place ${String(place)} in the tree's undo order could not be claimed; the in-process place is kept`;
    parts.log?.warn("compensation.order-unclaimed", text, {
      executionId: site.frame.execution.executionId,
      tenantId: tree.tenantId,
    });
  }
  return place;
}
