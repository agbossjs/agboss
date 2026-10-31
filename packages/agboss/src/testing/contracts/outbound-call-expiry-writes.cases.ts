import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import { OutboundCallLeaseState } from "../../infrastructure/execution-lease-event.repository.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import { seconds } from "../../units/index.js";
import { EXPIRY_EDGE_OFFSET, EXPIRY_EDGES, ExpiryEdge } from "./execution-lease-expiry.cases.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import { recorded, type OutboundCallCase, type OutboundCallStores } from "./outbound-call-data.js";

/** The lease of the cases below: 30 s, so its expiry is reached in a case. */
const LEASE = seconds(30);

const FAILURE = { name: "PaymentDeclinedError", code: "PaymentDeclinedError", message: "declined" };

/** One fenced call of the holder on an intent it recorded at the take. */
interface IntentWrite {
  readonly name: string;
  readonly call: (stores: OutboundCallStores, key: FencedEffectKey) => Promise<unknown>;
}

const INTENT_WRITES: readonly IntentWrite[] = [
  { name: "findByKey", call: (stores, key) => stores.calls.findByKey(key) },
  {
    name: "markCompleted",
    call: (stores, key) => stores.calls.markCompleted(key, "owner-1", '{"receipt":"r1"}'),
  },
  { name: "markFailed", call: (stores, key) => stores.calls.markFailed(key, "owner-1", FAILURE) },
  {
    name: "markPending",
    call: (stores, key) =>
      stores.calls.markPending(
        key,
        { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" },
        { attempt: 2, attemptOwner: "owner-2" },
      ),
  },
];

/**
 * The holder's fenced call on its intent at `edge`, nobody having taken the lease: 1 ms before the
 * expiry it goes through; at the expiry and after it the lease is over (#534) — refused
 * (`ExecutionFencedError`), and the intent stays as recorded: `Pending`, attempt 1, for whoever
 * reconciles it next. A late answer is never stored past the lease.
 */
const intentWriteAt = (write: IntentWrite, edge: ExpiryEdge): OutboundCallCase => {
  const isAccepted = edge === ExpiryEdge.Before;
  return {
    name: `#534: ${write.name} of a recorded intent ${edge}, the lease not taken meanwhile, ${isAccepted ? "goes through" : "is refused: the intent stays Pending at attempt 1"}`,
    run: async ({ clock, first, second }) => {
      const key = keyOf(await leaseOf(first, "execution-1", LEASE));
      await recorded(first, key);
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const outcome = await write.call(first, key).then(
        () => undefined,
        (error: unknown) => error,
      );

      if (isAccepted) {
        expect(outcome).toBeUndefined();
        return;
      }
      expect(outcome).toBeInstanceOf(ExecutionFencedError);
      const next = await leaseOf(second, "execution-1", LEASE);
      expect(await second.calls.findByKey(keyOf(next))).toMatchObject({
        status: OutboundCallStatus.Pending,
        attempt: 1,
        token: 1,
      });
    },
  };
};

/** The state of `stores`' view of `lease`. */
const stateOf = (stores: OutboundCallStores, lease: ExecutionLease) =>
  stores.calls.leaseStateOf({
    tenantId: lease.tenantId,
    leaseExecutionId: lease.rootExecutionId,
    token: lease.leaseEpoch,
  });

/**
 * `leaseStateOf` of a yielded lease (#516: still its holder's) at `edge`: `Live` 1 ms before the
 * expiry, `Superseded` at it and after it (#534) — and its holder's reclaim then refused.
 */
const yieldedStateAt = (edge: ExpiryEdge): OutboundCallCase => {
  const isLive = edge === ExpiryEdge.Before;
  return {
    name: `#534: leaseStateOf of a yielded lease ${edge} is ${isLive ? "Live" : "Superseded: its holder's reclaim refused"}`,
    run: async ({ clock, first, second }) => {
      const lease = await leaseOf(first, "execution-1", LEASE);
      expect(await first.leases.yield(lease)).toBe(true);
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const state = await stateOf(second, lease);
      const reclaimed = await first.leases.reclaim(lease, LEASE);

      expect(state).toBe(isLive ? OutboundCallLeaseState.Live : OutboundCallLeaseState.Superseded);
      expect(reclaimed !== undefined).toBe(isLive);
    },
  };
};

/**
 * `leaseStateOf` and the holder's renewal started at once at `edge`, in both orders: never both
 * win — 1 ms before the expiry the renewal stands and the lease is `Live`; at it and after it the
 * renewal is refused and the check closes the lease (`Superseded`, #534).
 */
const stateRacingRenewalAt = (edge: ExpiryEdge, isCheckFirst: boolean): OutboundCallCase => {
  const isLive = edge === ExpiryEdge.Before;
  return {
    name: `#534: leaseStateOf racing the holder's renewal ${edge} (${isCheckFirst ? "the check" : "the renewal"} started first): ${isLive ? "renewed and Live" : "refused and Superseded"}`,
    run: async ({ clock, first, second }) => {
      const lease = await leaseOf(first, "execution-1", LEASE);
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const [state, isRenewed] = isCheckFirst
        ? await Promise.all([stateOf(second, lease), first.leases.renew(lease, LEASE)])
        : await Promise.all([first.leases.renew(lease, LEASE), stateOf(second, lease)]).then(
            ([renewed, checked]) => [checked, renewed] as const,
          );

      expect(isRenewed).toBe(isLive);
      expect(state).toBe(isLive ? OutboundCallLeaseState.Live : OutboundCallLeaseState.Superseded);
    },
  };
};

/**
 * The outbound-call store's other fenced calls against the lease's boundary (#534), a yielded
 * lease's state there, and the state check racing the holder's renewal at each edge.
 */
export const OUTBOUND_EXPIRY_WRITE_CASES: readonly OutboundCallCase[] = [
  ...INTENT_WRITES.flatMap((write) => EXPIRY_EDGES.map((edge) => intentWriteAt(write, edge))),
  ...EXPIRY_EDGES.map(yieldedStateAt),
  ...EXPIRY_EDGES.flatMap((edge) =>
    [true, false].map((first) => stateRacingRenewalAt(edge, first)),
  ),
];
