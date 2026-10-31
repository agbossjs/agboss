import { ExecutionLeaseEventKind } from "../../../infrastructure/execution-lease-event.repository.js";
import type { FaultRun } from "../facts.js";
import { compareAt } from "../operation-history.js";
import { acceptedWritesOf, finishesOf, grantsOf, type Grant } from "./store-history.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * One owner per tree (#484 invariant 1), from the store history and the lease log:
 * - every epoch of a lease key is granted once, and a key's epochs grow in the order granted;
 * - a write the store accepted at token N came from the instance that was granted epoch N;
 * - no write is accepted at token N once epoch N + k was granted (its grant answered before the
 *   write was asked): the zombie's write is refused;
 * - the lease log has one takeover per token of an execution;
 * - no lease of finished work is granted again (#520).
 */

/** The grants of each key, in the order granted. */
const byKey = (grants: readonly Grant[]): ReadonlyMap<string, readonly Grant[]> => {
  const keys = new Map<string, Grant[]>();
  for (const grant of grants) keys.set(grant.key, [...(keys.get(grant.key) ?? []), grant]);
  return keys;
};

/** Each epoch once, and growing. */
function epochViolations(keys: ReadonlyMap<string, readonly Grant[]>): FaultViolation[] {
  return [...keys].flatMap(([key, grants]) =>
    grants.flatMap((grant, at) => {
      const earlier = grants.slice(0, at);
      if (earlier.some((other) => other.epoch === grant.epoch))
        return [
          violation(
            FaultInvariant.OneOwner,
            `epoch ${String(grant.epoch)} of ${key} was granted twice (the second to ${grant.holder})`,
          ),
        ];
      if (earlier.some((other) => other.epoch > grant.epoch))
        return [
          violation(
            FaultInvariant.OneOwner,
            `epoch ${String(grant.epoch)} of ${key} was granted after a higher one`,
          ),
        ];
      return [];
    }),
  );
}

/** Every accepted write is its epoch's holder's, and none follows a newer grant. */
function writeViolations(
  run: FaultRun,
  keys: ReadonlyMap<string, readonly Grant[]>,
): FaultViolation[] {
  return acceptedWritesOf(run.history).flatMap((write) => {
    const grants = keys.get(write.key) ?? [];
    const own = grants.find((grant) => grant.epoch === write.token);
    const found: FaultViolation[] = [];
    if (own !== undefined && own.holder !== write.instanceId)
      found.push(
        violation(
          FaultInvariant.OneOwner,
          `${write.operation} of ${write.key} at token ${String(write.token)} was accepted from ${write.instanceId}, but ${own.holder} held that epoch`,
        ),
      );
    const newer = grants.find(
      (grant) => grant.epoch > write.token && compareAt(grant.at, write.invokedAt) < 0,
    );
    if (newer !== undefined)
      found.push(
        violation(
          FaultInvariant.OneOwner,
          `${write.operation} of ${write.key} at token ${String(write.token)} (${write.instanceId}) was accepted after epoch ${String(newer.epoch)} was granted to ${newer.holder}: a stale write`,
        ),
      );
    return found;
  });
}

/** One takeover row per token of an execution. */
function takeoverViolations(run: FaultRun): FaultViolation[] {
  return run.trees.flatMap((tree) => {
    const seen = new Set<string>();
    return tree.leaseEvents.flatMap((row) => {
      if (row.kind !== ExecutionLeaseEventKind.Takeover) return [];
      const id = `${row.executionId}#${String(row.token)}`;
      if (!seen.has(id)) {
        seen.add(id);
        return [];
      }
      return [
        violation(
          FaultInvariant.OneOwner,
          `two takeovers of ${row.executionId} at token ${String(row.token)} in the lease log`,
        ),
      ];
    });
  });
}

/** No grant of a key after its lease was finished. */
function finishedViolations(run: FaultRun, grants: readonly Grant[]): FaultViolation[] {
  const finished = finishesOf(run.history);
  return grants.flatMap((grant) => {
    const at = finished.get(grant.key);
    if (at === undefined || compareAt(grant.at, at) <= 0) return [];
    return [
      violation(
        FaultInvariant.FinishedWorkUntouched,
        `the lease of ${grant.key} was granted again (epoch ${String(grant.epoch)}, to ${grant.holder}) after it was finished`,
      ),
    ];
  });
}

/** Every violation of one owner per tree, and of finished work left alone. */
export function oneOwnerViolations(run: FaultRun): FaultViolation[] {
  const grants = grantsOf(run.history);
  const keys = byKey(grants);
  return [
    ...epochViolations(keys),
    ...writeViolations(run, keys),
    ...takeoverViolations(run),
    ...finishedViolations(run, grants),
  ];
}
