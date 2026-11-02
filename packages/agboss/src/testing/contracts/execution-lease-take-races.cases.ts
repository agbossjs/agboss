import { expect } from "vitest";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";

/**
 * Two takes of one free lease at once (#695): a tree never leased, one whose lease was released,
 * one whose lease expired — both instances' `acquire` sent together, round after round, in both
 * orders. Exactly one is given the lease, at the next epoch; the other is refused. A store whose
 * `acquire` reads the lease, decides "free" in its code and then writes the next epoch (check, then
 * write) gives it to both — two owners — and passes every other case of the contract.
 */

/** What a case gets: the two instances of the lease store. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** A tree's lease for 30 s. */
const LEASE = seconds(30);

/** How many times each race is run, alternating which instance sends first. */
const ROUNDS = 10;

/** How the raced lease was made free. */
enum FreeLease {
  NeverLeased = "never leased",
  Released = "released",
  Expired = "expired",
}

/** Makes `rootExecutionId`'s lease free as `how` says; the epoch the next take must be given. */
async function freed(
  { clock, first }: Instances,
  rootExecutionId: string,
  how: FreeLease,
): Promise<number> {
  if (how === FreeLease.NeverLeased) return 1;
  const held = await first.acquire("default", rootExecutionId, LEASE);
  if (held === undefined) throw new Error(`the first take of ${rootExecutionId} was refused`);
  if (how === FreeLease.Released) await first.release(held);
  else await clock.advance(seconds(31));
  return held.leaseEpoch + 1;
}

const takeRace = (how: FreeLease): ContractCase<ExecutionLeaseRepository> => ({
  name: `#695: two instances take one ${how} lease at once, round after round, in both orders: exactly one is given it, at the next epoch`,
  run: async (instances: Instances): Promise<void> => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const root = `race-${String(round)}`;
      const epoch = await freed(instances, root, how);
      const [one, other] =
        round % 2 === 0 ? [instances.first, instances.second] : [instances.second, instances.first];

      const taken = await Promise.all([
        one.acquire("default", root, LEASE),
        other.acquire("default", root, LEASE),
      ]);

      const given = taken.filter((lease): lease is ExecutionLease => lease !== undefined);
      expect(given, `round ${String(round)}: two owners of one free lease`).toHaveLength(1);
      expect(given[0]?.leaseEpoch).toBe(epoch);
    }
  },
});

export const LEASE_TAKE_RACE_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  takeRace(FreeLease.NeverLeased),
  takeRace(FreeLease.Released),
  takeRace(FreeLease.Expired),
];
