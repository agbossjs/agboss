import type { ExecutionLease } from "../../../infrastructure/execution-lease.repository.js";
import type { ExplorerRun } from "./run.js";
import { EXPLORED_LEASE, EXPLORED_TENANT, LeaseOperation } from "./types.js";

/**
 * What each explorer action does to the store and tells the observer (#533 item 1); each returns
 * the text the printed schedule shows for it.
 */

/** The lease objects each instance holds, as the store gave them (renew, release … take them). */
const heldLeases = new WeakMap<ExplorerRun, Map<string, ExecutionLease>>();

const leasesOf = (run: ExplorerRun): Map<string, ExecutionLease> => {
  const found = heldLeases.get(run) ?? new Map<string, ExecutionLease>();
  heldLeases.set(run, found);
  return found;
};

/** The lease `instance` last held on `tree`, as the store gave it. */
export const heldLeaseOf = (
  run: ExplorerRun,
  instance: number,
  tree: string,
): ExecutionLease | undefined => leasesOf(run).get(`${String(instance)}|${tree}`);

const keep = (run: ExplorerRun, instance: number, lease: ExecutionLease): void => {
  leasesOf(run).set(`${String(instance)}|${lease.rootExecutionId}`, lease);
};

/** A lease as the schedule prints it. */
const grantedText = (lease: ExecutionLease): string => {
  const from = lease.takenOverFrom;
  const over =
    from === undefined ? "" : `, taken over from ${from.holderInstanceId} at ${String(from.token)}`;
  return `→ epoch ${String(lease.token)}, ${String(lease.remaining)} ms left${over}`;
};

async function acquired(run: ExplorerRun, instance: number, tree: string): Promise<string> {
  const now = run.now;
  const lease = await run.storesOf(instance).leases.acquire(EXPLORED_TENANT, tree, EXPLORED_LEASE);
  if (lease === undefined) return "→ refused";
  run.observer.grant(instance, tree, lease.token, lease.remaining, now);
  keep(run, instance, lease);
  return grantedText(lease);
}

/** The held lease of `instance` on `tree`; an action is enabled only with one. */
const heldOf = (run: ExplorerRun, instance: number, tree: string): ExecutionLease => {
  const lease = heldLeaseOf(run, instance, tree);
  if (lease === undefined)
    throw new TypeError(`instance-${String(instance)} holds no lease of ${tree}`);
  return lease;
};

async function renewed(run: ExplorerRun, instance: number, tree: string): Promise<string> {
  const now = run.now;
  const lease = heldOf(run, instance, tree);
  const remaining = await run.storesOf(instance).leases.renew(lease, EXPLORED_LEASE);
  if (remaining === undefined) {
    run.observer.ended(instance, tree);
    return "→ refused";
  }
  run.observer.accepted(`instance-${String(instance)}'s renewal`, tree, lease.token, now);
  run.observer.renewed(instance, tree, remaining, now);
  return `→ ${String(remaining)} ms left`;
}

async function yielded(run: ExplorerRun, instance: number, tree: string): Promise<string> {
  const now = run.now;
  const lease = heldOf(run, instance, tree);
  const isYielded = (await run.storesOf(instance).leases.yield(lease)) !== undefined;
  const belief = run.observer.beliefOf(instance, tree);
  if (!isYielded) run.observer.ended(instance, tree);
  else run.observer.accepted(`instance-${String(instance)}'s yield`, tree, lease.token, now);
  if (isYielded && belief !== undefined) belief.yielded = true;
  return `→ ${String(isYielded)}`;
}

async function reclaimed(run: ExplorerRun, instance: number, tree: string): Promise<string> {
  const now = run.now;
  const lease = heldOf(run, instance, tree);
  const taken = await run.storesOf(instance).leases.reclaim(lease, EXPLORED_LEASE);
  if (taken === undefined) {
    run.observer.ended(instance, tree);
    return "→ refused";
  }
  run.observer.accepted(`instance-${String(instance)}'s reclaim`, tree, lease.token, now);
  run.observer.grant(instance, tree, taken.token, taken.remaining, now);
  keep(run, instance, taken);
  return grantedText(taken);
}

async function letGo(
  run: ExplorerRun,
  instance: number,
  tree: string,
  isRetired: boolean,
): Promise<string> {
  const lease = heldOf(run, instance, tree);
  const leases = run.storesOf(instance).leases;
  await (isRetired ? leases.retire(lease) : leases.release(lease));
  run.observer.released(instance, tree, lease.token, isRetired);
  return `epoch ${String(lease.token)}`;
}

/** A lease operation. */
export function leaseStep(
  run: ExplorerRun,
  operation: LeaseOperation,
  instance: number,
  tree: string,
): Promise<string> {
  switch (operation) {
    case LeaseOperation.Acquire:
      return acquired(run, instance, tree);
    case LeaseOperation.Renew:
      return renewed(run, instance, tree);
    case LeaseOperation.Yield:
      return yielded(run, instance, tree);
    case LeaseOperation.Reclaim:
      return reclaimed(run, instance, tree);
    case LeaseOperation.Release:
      return letGo(run, instance, tree, false);
    case LeaseOperation.Retire:
      return letGo(run, instance, tree, true);
  }
}
