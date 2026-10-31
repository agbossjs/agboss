import { expect } from "vitest";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** A tree's lease for 30 s. */
const LEASE = seconds(30);

/** Where a case stands against the lease's `expiresAt`: 1 ms before, exactly at it, 1 ms after. */
export enum ExpiryEdge {
  Before = "1 ms before its expiry",
  At = "exactly at its expiry",
  After = "1 ms after its expiry",
}

/** How far the clock moves from the take for each edge. */
export const EXPIRY_EDGE_OFFSET: Readonly<Record<ExpiryEdge, Milliseconds>> = {
  [ExpiryEdge.Before]: seconds(29.999),
  [ExpiryEdge.At]: LEASE,
  [ExpiryEdge.After]: seconds(30.001),
};

/** The edges in time order. */
export const EXPIRY_EDGES: readonly ExpiryEdge[] = [
  ExpiryEdge.Before,
  ExpiryEdge.At,
  ExpiryEdge.After,
];

/** The lease of `root-1` taken by `store`; yielded at once when `isYielded`. */
async function heldBy(
  store: ExecutionLeaseRepository,
  isYielded: boolean,
): Promise<ExecutionLease> {
  const held = await store.acquire("default", "root-1", LEASE);
  if (held === undefined) throw new Error("the first acquire of a free tree must take its lease");
  if (isYielded) expect(await store.yield(held)).toBe(true);
  return held;
}

/** One operation of the holder on its own lease, and whether it kept the lease. */
interface HolderOperation {
  readonly name: string;
  readonly isYielded: boolean;
  readonly call: (store: ExecutionLeaseRepository, held: ExecutionLease) => Promise<boolean>;
}

const HOLDER_OPERATIONS: readonly HolderOperation[] = [
  {
    name: "renew of a held lease",
    isYielded: false,
    call: (store, held) => store.renew(held, LEASE),
  },
  {
    name: "renew of a yielded lease",
    isYielded: true,
    call: (store, held) => store.renew(held, LEASE),
  },
  {
    name: "reclaim of a yielded lease",
    isYielded: true,
    call: async (store, held) => (await store.reclaim(held, LEASE)) !== undefined,
  },
  {
    name: "yield of a held lease",
    isYielded: false,
    call: (store, held) => store.yield(held),
  },
];

/**
 * The holder's operation at `edge`, nobody having taken the lease: 1 ms before its expiry it keeps
 * the lease (another acquire is still refused); at its expiry and after it the lease is over for the
 * holder too (#534) — refused, and the lease free for the next take.
 */
const holderAt = (
  operation: HolderOperation,
  edge: ExpiryEdge,
): ContractCase<ExecutionLeaseRepository> => {
  const isKept = edge === ExpiryEdge.Before;
  return {
    name: `#534: ${operation.name} ${edge}, not taken meanwhile, is ${isKept ? "kept" : "refused: the lease is over for its holder too"}`,
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const held = await heldBy(first, operation.isYielded);
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const isKeptNow = await operation.call(first, held);
      const taken = await second.acquire("default", "root-1", LEASE);

      expect(isKeptNow).toBe(isKept);
      if (isKept) expect(taken).toBeUndefined();
      else
        expect(taken).toMatchObject({
          holderInstanceId: "instance-2",
          leaseEpoch: 2,
          takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
        });
    },
  };
};

/** At and after its expiry the holder takes its lease only by a new `acquire`: a takeover from itself. */
const holderAcquiresAgain = (edge: ExpiryEdge): ContractCase<ExecutionLeaseRepository> => ({
  name: `#534: a holder refused ${edge} takes its tree again only by acquire — a new epoch, taken over from itself — and its old lease stays refused`,
  run: async ({ clock, first, second }: Instances): Promise<void> => {
    const held = await heldBy(first, false);
    await clock.advance(EXPIRY_EDGE_OFFSET[edge]);
    expect(await first.renew(held, LEASE)).toBe(false);

    const again = await first.acquire("default", "root-1", LEASE);

    expect(again).toMatchObject({
      holderInstanceId: "instance-1",
      leaseEpoch: 2,
      takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
    });
    expect(await first.renew(held, LEASE)).toBe(false);
    expect(await first.reclaim(held, LEASE)).toBeUndefined();
    expect(await first.yield(held)).toBe(false);
    expect(again && (await first.renew(again, LEASE))).toBe(true);
    expect(await second.acquire("default", "root-1", LEASE)).toBeUndefined();
  },
});

/** At its expiry the instant belongs to the taker: a renewal and a take never both win. */
const takeAndRenewAtExpiry: ContractCase<ExecutionLeaseRepository> = {
  name: "#534: exactly at its expiry another instance's take and the holder's renewal never both win — the take stands, the renewal is refused, in either order",
  run: async ({ clock, first, second }: Instances): Promise<void> => {
    const renewing = await heldBy(first, false);
    const other = await first.acquire("default", "root-2", LEASE);
    await clock.advance(LEASE);

    const isRenewedBeforeTake = await first.renew(renewing, LEASE);
    const takenAfterRenewal = await second.acquire("default", "root-1", LEASE);
    const takenBeforeRenewal = await second.acquire("default", "root-2", LEASE);
    const isRenewedAfterTake = other && (await first.renew(other, LEASE));

    expect(isRenewedBeforeTake).toBe(false);
    expect(takenAfterRenewal).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    expect(takenBeforeRenewal).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    expect(isRenewedAfterTake).toBe(false);
  },
};

/**
 * The lease's boundary (#534): live while `expiresAt > now`, and only then — for every instance,
 * its holder included. Each holder operation 1 ms before, exactly at and 1 ms after the expiry; the
 * refused holder's way back (a new acquire, a takeover from itself); the instant of expiry belongs
 * to the taker.
 */
export const LEASE_EXPIRY_CASES: readonly ContractCase<ExecutionLeaseRepository>[] = [
  ...HOLDER_OPERATIONS.flatMap((operation) =>
    EXPIRY_EDGES.map((edge) => holderAt(operation, edge)),
  ),
  holderAcquiresAgain(ExpiryEdge.At),
  holderAcquiresAgain(ExpiryEdge.After),
  takeAndRenewAtExpiry,
];
