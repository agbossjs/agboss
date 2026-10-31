import { expect } from "vitest";
import { executionLeasesOf, type HeldExecutionLease } from "../../app/execution-leases.js";
import { ExecutionLeaseLostError } from "../../app/lease-lost.js";
import { Clock } from "../../infrastructure/clock.js";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { ExecutionTree } from "../../infrastructure/execution-tree.repository.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import { EXPIRY_EDGE_OFFSET, EXPIRY_EDGES, ExpiryEdge } from "./execution-lease-expiry.cases.js";
import type { ContractInstances } from "./seam.js";

/** What each case below gets. */
type Instances = ContractInstances<ExecutionLeaseRepository>;

/** The tree of the leases below: the tenant `"default"`, one root. */
const ROOT_1: ExecutionTree = { tenantId: "default", rootExecutionId: "root-1" };

/**
 * The holder's time during a stop-the-world pause (a GC pause, a frozen VM): it reads the case's
 * clock, but none of its timers fires — its background renewal and its local expiry do not run
 * before the step that resumes first asks the store. Only the store then decides; a sleep ends
 * when its signal aborts (the holder released), as `Clock.sleep` promises.
 */
class PausedTimersClock extends Clock {
  constructor(private readonly time: Clock) {
    super();
  }

  now(): Date {
    return this.time.now();
  }

  sleep(_delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) resolve();
      else
        signal?.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
    });
  }
}

/** One of the holder's own calls to the store, the moment it asks. */
interface HolderCall {
  readonly name: string;
  readonly call: (holder: HeldExecutionLease) => Promise<void>;
}

const HOLDER_CALLS: readonly HolderCall[] = [
  { name: "fence.confirmNow()", call: (holder) => holder.confirmNow() },
  { name: "the renewal before a checkpoint write", call: (holder) => holder.renewNow() },
];

/**
 * The framework's holder resumes from a pause at `edge` with its timers not yet run, and asks the
 * store first: 1 ms before the expiry it is confirmed and goes on; at the expiry and after it the
 * lease is over (#534) — the call rejects with `ExecutionLeaseLostError`, the holder's signal
 * aborts, and the tree is free for the next take, a takeover from that holder.
 */
const holderCallAt = (
  holderCall: HolderCall,
  edge: ExpiryEdge,
): ContractCase<ExecutionLeaseRepository> => {
  const isKept = edge === ExpiryEdge.Before;
  return {
    name: `#534: ${holderCall.name} ${edge}, its timers paused, is ${isKept ? "confirmed: the holder goes on" : "lost: the holder stops and the tree is taken over"}`,
    run: async ({ clock, first, second }: Instances): Promise<void> => {
      const holder = await executionLeasesOf(first, new PausedTimersClock(clock)).hold(ROOT_1);
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const outcome = await holderCall.call(holder).then(
        () => undefined,
        (error: unknown) => error,
      );
      const taken = await second.acquire("default", "root-1", seconds(30));

      if (isKept) {
        expect(outcome).toBeUndefined();
        expect(holder.signal.aborted).toBe(false);
        expect(holder.token).toBe(1);
        expect(taken).toBeUndefined();
      } else {
        expect(outcome).toBeInstanceOf(ExecutionLeaseLostError);
        expect(holder.signal.aborted).toBe(true);
        expect(taken).toMatchObject({
          holderInstanceId: "instance-2",
          leaseEpoch: 2,
          takenOverFrom: { holderInstanceId: "instance-1", leaseEpoch: 1 },
        });
      }
      await holder.release();
    },
  };
};

/**
 * The framework's holder against the lease's boundary (#534): its own store calls after a pause
 * that stopped its timers — `confirmNow()` and the renewal before a checkpoint write — 1 ms before,
 * exactly at and 1 ms after the expiry. The store's refusal is what stops it there.
 */
export const LEASE_CONFIRM_CASES: readonly ContractCase<ExecutionLeaseRepository>[] =
  HOLDER_CALLS.flatMap((holderCall) => EXPIRY_EDGES.map((edge) => holderCallAt(holderCall, edge)));
