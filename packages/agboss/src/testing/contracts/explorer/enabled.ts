import type { ExplorerRun } from "./run.js";
import { nextEndOf } from "./moves.js";
import { heldLeaseOf } from "./steps.js";
import { ExplorerWorldKind, LeaseOperation, TimeStep, type ExplorerAction } from "./types.js";

/**
 * Which actions the scheduler may pick next (#533 item 1): what each instance can do now with
 * what it believes — a take when it trusts no lease, the holder's operations while it believes it
 * holds one (also once that trust ran out: a frozen holder does not know), a zombie's write at the
 * last token it held, its call's next operation — and the time: a renewal's beat, or to the next
 * lease's end, 1 ms before and at it.
 */

/** The holder's operations each world explores. */
const HOLDER_OPERATIONS: Readonly<Record<ExplorerWorldKind, readonly LeaseOperation[]>> = {
  [ExplorerWorldKind.Lease]: [
    LeaseOperation.Renew,
    LeaseOperation.Yield,
    LeaseOperation.Reclaim,
    LeaseOperation.Release,
    LeaseOperation.Finish,
  ],
  [ExplorerWorldKind.FencedEffect]: [LeaseOperation.Renew, LeaseOperation.Release],
  [ExplorerWorldKind.OutboundCall]: [LeaseOperation.Renew],
};

/** The lease operations `instance` may make on `tree`. */
function leaseActions(run: ExplorerRun, instance: number, tree: string): ExplorerAction[] {
  const belief = run.observer.beliefOf(instance, tree);
  const lease = (operation: LeaseOperation): ExplorerAction => ({
    kind: "lease",
    operation,
    instance,
    tree,
  });
  if (belief === undefined || heldLeaseOf(run, instance, tree) === undefined)
    return [lease(LeaseOperation.Acquire)];
  return HOLDER_OPERATIONS[run.world.kind]
    .filter((operation) => operation !== LeaseOperation.Yield || !belief.yielded)
    .filter((operation) => operation !== LeaseOperation.Reclaim || belief.yielded)
    .map(lease);
}

/** What else `instance` may do on `tree` in this world. */
function otherActions(run: ExplorerRun, instance: number, tree: string): ExplorerAction[] {
  const token = run.observer.tokenOf(instance, tree);
  if (token === undefined) return [];
  switch (run.world.kind) {
    case ExplorerWorldKind.Lease:
      // #694: `leaseStateOf` only with the outbound-call store; the lease store alone has none
      return run.observer.beliefOf(instance, tree) === undefined &&
        run.storesOf(instance).calls !== undefined
        ? [{ kind: "check", instance, tree }]
        : [];
    case ExplorerWorldKind.FencedEffect:
      return run.writes.has(`${String(instance)}|${tree}|${String(token)}`)
        ? []
        : [{ kind: "write", instance, tree }];
    case ExplorerWorldKind.OutboundCall:
      return callActions(run, instance, tree);
  }
}

/** The call's next operation, or the other system taking its request in flight. */
function callActions(run: ExplorerRun, instance: number, tree: string): ExplorerAction[] {
  const phase = run.phaseOf(instance, tree);
  if (phase.phase === "done") return [];
  if (phase.phase === "flight")
    return run.observer.isTrusting(instance, tree, run.now) &&
      run.observer.beliefOf(instance, tree)?.epoch === phase.epoch
      ? [
          { kind: "deliver", instance, tree, isAccepted: true },
          { kind: "deliver", instance, tree, isAccepted: false },
        ]
      : [];
  // a call starts (and starts over) only under a lease its instance trusts; mid-way it goes on
  if (phase.phase === "read" && !run.observer.isTrusting(instance, tree, run.now)) return [];
  return [{ kind: "call", instance, tree }];
}

/** The time steps: a beat always, the next end's edges while a lease is live. */
function timeActions(run: ExplorerRun): ExplorerAction[] {
  const beat: ExplorerAction = { kind: "time", step: TimeStep.Beat };
  const end = nextEndOf(run);
  if (end === undefined) return [beat];
  const edges: ExplorerAction[] = [{ kind: "time", step: TimeStep.End }];
  if (end - run.now > 1) edges.unshift({ kind: "time", step: TimeStep.BeforeEnd });
  return [beat, ...edges];
}

/** Every action the scheduler may pick now, in a fixed order. */
export function enabledActions(run: ExplorerRun): ExplorerAction[] {
  const actions: ExplorerAction[] = [];
  for (let instance = 1; instance <= run.world.instances; instance += 1) {
    const tree = run.world.treeOf(instance);
    actions.push(...leaseActions(run, instance, tree), ...otherActions(run, instance, tree));
  }
  return [...actions, ...timeActions(run)];
}

/** Whether two actions are the same choice. */
export const isSameAction = (left: ExplorerAction, right: ExplorerAction): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
