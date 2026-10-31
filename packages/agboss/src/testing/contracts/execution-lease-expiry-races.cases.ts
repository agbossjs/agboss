import { expect } from "vitest";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import { EXPIRY_EDGE_OFFSET, EXPIRY_EDGES, ExpiryEdge } from "./execution-lease-expiry.cases.js";
import type { ContractInstances } from "./seam.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** A tree's lease for 30 s. */
const LEASE = seconds(30);

/** How many times each race runs: a store that lets both win now and then loses one of them. */
const ROUNDS = 5;

/** The holder's call that races a take: a renewal of a held lease, or a reclaim of a yielded one. */
interface RacingCall {
  readonly name: string;
  readonly isYielded: boolean;
  readonly call: (store: ExecutionLeaseRepository, held: ExecutionLease) => Promise<boolean>;
}

const RACING_CALLS: readonly RacingCall[] = [
  { name: "a renewal", isYielded: false, call: (store, held) => store.renew(held, LEASE) },
  {
    name: "a reclaim of a yielded lease",
    isYielded: true,
    call: async (store, held) => (await store.reclaim(held, LEASE)) !== undefined,
  },
];

/** The holder's call and another instance's take of `held`'s tree, started at once. */
const raced = (
  racing: RacingCall,
  { first, second }: Instances,
  held: ExecutionLease,
): Promise<readonly [boolean, ExecutionLease | undefined]> =>
  Promise.all([racing.call(first, held), second.acquire("default", held.rootExecutionId, LEASE)]);

/**
 * The holder's call and another instance's take started at once, at `edge`, nobody else near:
 * exactly one of them wins, never both, never neither — 1 ms before the expiry the holder (the take
 * refused), at it and after it the taker (the holder refused, #534). Each round on a tree of its own.
 */
const raceAt = (racing: RacingCall, edge: ExpiryEdge): ContractCase<ExecutionLeaseRepository> => {
  const isHolderWinning = edge === ExpiryEdge.Before;
  return {
    name: `#534: ${racing.name} racing another instance's take ${edge}: exactly one wins — ${isHolderWinning ? "the holder" : "the taker"}`,
    run: async (instances: Instances): Promise<void> => {
      const held: ExecutionLease[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const lease = await instances.first.acquire("default", `race-${String(round)}`, LEASE);
        if (lease === undefined) throw new Error("the first acquire of a free tree takes it");
        if (racing.isYielded) expect(await instances.first.yield(lease)).toBe(true);
        held.push(lease);
      }
      await instances.clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const outcomes = await Promise.all(held.map((lease) => raced(racing, instances, lease)));

      for (const [isKept, taken] of outcomes) {
        expect(isKept).toBe(isHolderWinning);
        if (isHolderWinning) expect(taken).toBeUndefined();
        else expect(taken).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
      }
    },
  };
};

/**
 * A renewal extends the lease by its length from the moment it is made, never from the old expiry
 * (#534's boundary moves with it): renewed 1 ms before the expiry, the lease is live until 1 ms
 * before the second lease ends and over exactly then — for its holder and for a take.
 */
const renewedFromNow: ContractCase<ExecutionLeaseRepository> = {
  name: "#534: a renewal 29.999 s into the lease moves its end to a lease after the renewal, not a lease after the old end",
  run: async ({ clock, first, second }: Instances): Promise<void> => {
    const held = await first.acquire("default", "root-1", LEASE);
    if (held === undefined) throw new Error("the first acquire of a free tree takes it");
    await clock.advance(seconds(29.999));
    expect(await first.renew(held, LEASE)).toBe(true);

    await clock.advance(seconds(29.999));
    const refusedJustBefore = await second.acquire("default", "root-1", LEASE);
    await clock.advance(seconds(0.001));
    const isRenewedAtSecondExpiry = await first.renew(held, LEASE);
    const taken = await second.acquire("default", "root-1", LEASE);

    expect(refusedJustBefore).toBeUndefined();
    expect(isRenewedAtSecondExpiry).toBe(false);
    expect(taken).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
  },
};

/**
 * The lease's boundary under concurrency (#534): the holder's renewal or reclaim and another
 * instance's take started at once, at each edge, on several trees at a time — exactly one wins; and a
 * renewal's new boundary counts from the renewal.
 */
export const LEASE_EXPIRY_RACE_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  ...RACING_CALLS.flatMap((racing) => EXPIRY_EDGES.map((edge) => raceAt(racing, edge))),
  renewedFromNow,
];
