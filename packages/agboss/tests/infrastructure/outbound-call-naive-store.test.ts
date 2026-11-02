/**
 * #508 re-review MEDIUM5 — the outbound-call contract's races catch a store that is not atomic: a
 * SELECT-then-UPDATE port (the fenced read, the network, a write keyed by row only), alone or
 * serialized per lease row (as `SELECT … FROM execution_leases FOR UPDATE` would), fails them — a
 * business key's one row is moved under two leases, which no lease lock serializes — while the
 * core's in-memory store passes them. A `leaseStateOf` that reads, then closes in a second step,
 * failed its race with a late renewal before #534; since then the lease store refuses a renewal
 * past the expiry, so an expired lease stays expired until a take, and it passes both races.
 */
import { describe, expect, it } from "vitest";
import { OutboundCallLeaseState } from "../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { fencedKeyIdentityOf } from "../../src/infrastructure/fenced-effect-key.js";
import { treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import type { FencedEffectKey } from "../../src/infrastructure/fenced-effect.repository.js";
import { endedOf, isInState, withoutEnd } from "../../src/infrastructure/outbound-call-changes.js";
import {
  InMemoryOutboundCallRepository,
  OutboundCallStatus,
  type OutboundCallClaim,
  type OutboundCallLease,
  type OutboundCallFailure,
  type OutboundCallRecord,
  type OutboundCallState,
} from "../../src/infrastructure/outbound-call.repository.js";
import { outboundLeaseRaceCases } from "../../src/testing/contracts/outbound-call-lease.cases.js";
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
      seam.storeClock,
      seam.application,
      seam.database,
    );
    const rows = seam.database.outboundCalls;
    const endedAt = () => seam.storeClock.now().toISOString();
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
          rows.set(fencedKeyIdentityOf(key), { ...changed, token: key.token });
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
    return { calls: new CheckThenWrite(seam.storeClock, seam.database, leases), leases };
  };

/**
 * A store whose `leaseStateOf` is a SELECT, a round trip, then the close as a conditional UPDATE —
 * `Superseded` whatever the UPDATE matched: a renewal landing between them is missed.
 */
const naiveLeaseState: StoreFactory<OutboundCallStores> = (seam) => {
  const leases = new InMemoryExecutionLeaseRepository(
    seam.storeClock,
    seam.application,
    seam.database,
  );
  const rows = seam.database.executionLeases;
  class SelectThenUpdate extends InMemoryOutboundCallRepository {
    override async leaseStateOf({ tenantId, leaseExecutionId, token }: OutboundCallLease) {
      const key = treeKeyOf(tenantId, leaseExecutionId);
      const read = rows.get(key);
      if (read === undefined || read.released || read.lease.leaseEpoch !== token)
        return OutboundCallLeaseState.Ended;
      if (read.lease.expiresAt > seam.storeClock.now()) return OutboundCallLeaseState.Live;
      await roundTrip();
      const row = rows.get(key);
      const isStillExpired =
        row !== undefined &&
        !row.released &&
        row.lease.leaseEpoch === token &&
        row.lease.expiresAt <= seam.storeClock.now();
      if (isStillExpired) rows.set(key, { ...row, released: true });
      return OutboundCallLeaseState.Superseded;
    }
  }
  return { calls: new SelectThenUpdate(seam.storeClock, seam.database, leases), leases };
};

const unlocked: Lock = (_key, work) => work();

const core: StoreFactory<OutboundCallStores> = (seam) => {
  const leases = new InMemoryExecutionLeaseRepository(
    seam.storeClock,
    seam.application,
    seam.database,
  );
  return {
    calls: new InMemoryOutboundCallRepository(seam.storeClock, seam.database, leases),
    leases,
  };
};

/** Whether the race case named like `pattern` fails on the stores `make` builds. */
async function failsOn(make: StoreFactory<OutboundCallStores>, pattern: RegExp): Promise<boolean> {
  const cases = [...outboundRaceCases().cases, ...outboundLeaseRaceCases().cases];
  const race = cases.find((contractCase) => pattern.test(contractCase.name));
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
const LIVENESS = [
  /leaseStateOf of an expired lease racing its holder's renewal/u,
  /leaseStateOf of an expired lease racing another instance's take/u,
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

  it("#534: a leaseStateOf that is a SELECT, a round trip, then a conditional UPDATE no longer loses either race — the lease store refuses a renewal past the expiry, so an expired lease stays expired until a take, which the UPDATE's condition excludes", async () => {
    for (const pattern of LIVENESS)
      expect({ pattern, fails: await failsOn(naiveLeaseState, pattern) }).toEqual({
        pattern,
        fails: false,
      });
  });

  it("the core's in-memory store passes every one of them", async () => {
    for (const pattern of [...ONE_LEASE, ...CROSS_LEASE, ...LIVENESS])
      expect({ pattern, fails: await failsOn(core, pattern) }).toEqual({ pattern, fails: false });
  });
});
