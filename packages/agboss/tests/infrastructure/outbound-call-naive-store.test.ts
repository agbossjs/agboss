/**
 * #508 re-review MEDIUM5 — the outbound-call contract's races catch a store that is not atomic: a
 * SELECT-then-UPDATE port (the fenced read, the network, a write keyed by row only), alone or
 * serialized per lease row (as `SELECT … FROM execution_leases FOR UPDATE` would), fails them — a
 * business key's one row is moved under two leases, which no lease lock serializes — while the
 * core's in-memory store passes them.
 */
import { describe, expect, it } from "vitest";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { identityOf } from "../../src/infrastructure/fenced-effect-key.js";
import type { FencedEffectKey } from "../../src/infrastructure/fenced-effect.repository.js";
import {
  endedOf,
  InMemoryOutboundCallRepository,
  isInState,
  OutboundCallStatus,
  withoutEnd,
  type OutboundCallClaim,
  type OutboundCallFailure,
  type OutboundCallRecord,
  type OutboundCallState,
} from "../../src/infrastructure/outbound-call.repository.js";
import { outboundRaceCases } from "../../src/testing/contracts/outbound-call-race.cases.js";
import type { OutboundCallStores } from "../../src/testing/contracts/index.js";
import { withTarget } from "../../src/testing/contracts/seam.js";
import { inMemoryTarget, type StoreFactory } from "./contracts/store-kinds.js";

/** One real millisecond: the gap a network round trip leaves between a read and a write. */
const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 1));

/** A per-lease mutex: what a lock on the lease row serializes — one lease, never one intent. */
function leaseLock(): <T>(key: FencedEffectKey, work: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<unknown>>();
  return <T>(key: FencedEffectKey, work: () => Promise<T>): Promise<T> => {
    const id = `${key.tenantId}/${key.leaseExecutionId}`;
    const next = (locks.get(id) ?? Promise.resolve()).then(work, work);
    locks.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  };
}

type Lock = <T>(key: FencedEffectKey, work: () => Promise<T>) => Promise<T>;

/** A store that reads fenced, waits, then writes by row — no state, no fence at the write. */
const naive =
  (lock: Lock): StoreFactory<OutboundCallStores> =>
  (seam) => {
    const leases = new InMemoryExecutionLeaseRepository(
      seam.clock,
      seam.application,
      seam.database,
    );
    const rows = seam.database.outboundCalls;
    const endedAt = () => seam.clock.now().toISOString();
    class CheckThenWrite extends InMemoryOutboundCallRepository {
      #written(
        key: FencedEffectKey,
        change: (found: OutboundCallRecord) => OutboundCallRecord | undefined,
      ): Promise<boolean> {
        return lock(key, async () => {
          const found = await this.findByKey(key);
          await roundTrip();
          const changed = found === undefined ? undefined : change(found);
          if (changed === undefined) return false;
          await roundTrip();
          rows.set(identityOf(key), { ...changed, token: key.token });
          return true;
        });
      }

      override markPending(
        key: FencedEffectKey,
        expected: OutboundCallState,
        claim: OutboundCallClaim,
      ) {
        return this.#written(key, (found) =>
          isInState(found, expected)
            ? { ...withoutEnd(found), status: OutboundCallStatus.Pending, ...claim }
            : undefined,
        );
      }

      override markCompleted(key: FencedEffectKey, owner: string, result: string) {
        const ending = { status: OutboundCallStatus.Completed, result } as const;
        return this.#written(key, (found) => endedOf(found, owner, ending, endedAt()));
      }

      override markFailed(key: FencedEffectKey, owner: string, failure: OutboundCallFailure) {
        const ending = { status: OutboundCallStatus.Failed, failure } as const;
        return this.#written(key, (found) => endedOf(found, owner, ending, endedAt()));
      }
    }
    return { calls: new CheckThenWrite(seam.clock, seam.database, leases), leases };
  };

const unlocked: Lock = (_key, work) => work();

const core: StoreFactory<OutboundCallStores> = (seam) => {
  const leases = new InMemoryExecutionLeaseRepository(seam.clock, seam.application, seam.database);
  return { calls: new InMemoryOutboundCallRepository(seam.clock, seam.database, leases), leases };
};

/** Whether the race case named like `pattern` fails on the stores `make` builds. */
async function failsOn(make: StoreFactory<OutboundCallStores>, pattern: RegExp): Promise<boolean> {
  const race = outboundRaceCases().cases.find((contractCase) => pattern.test(contractCase.name));
  if (race === undefined) throw new Error(`no race case like ${String(pattern)}`);
  return withTarget(inMemoryTarget(make), race.run)().then(
    () => false,
    () => true,
  );
}

const CROSS_LEASE = [
  /its attempt's markCompleted under one lease/u,
  /a new attempt's claim under one lease/u,
];
const ONE_LEASE = [
  /two instances moving one pending intent/u,
  /markCompleted of an attempt racing/u,
  /markFailed of an attempt racing/u,
  /a write racing its lease's release/u,
];

describe("#508 re-review MEDIUM5: the races fail every store that is not atomic", () => {
  it("a check-then-write store fails every race — the takeover race by its order, the cross-lease ones by their one row", async () => {
    for (const pattern of [...ONE_LEASE, ...CROSS_LEASE])
      expect({ pattern, fails: await failsOn(naive(unlocked), pattern) }).toEqual({
        pattern,
        fails: true,
      });
  });

  it("a check-then-write store serialized per lease row fails the cross-lease races: two leases, one business key's row", async () => {
    for (const pattern of CROSS_LEASE)
      expect({ pattern, fails: await failsOn(naive(leaseLock()), pattern) }).toEqual({
        pattern,
        fails: true,
      });
  });

  it("the core's in-memory store passes every one of them", async () => {
    for (const pattern of [...ONE_LEASE, ...CROSS_LEASE])
      expect({ pattern, fails: await failsOn(core, pattern) }).toEqual({ pattern, fails: false });
  });
});
