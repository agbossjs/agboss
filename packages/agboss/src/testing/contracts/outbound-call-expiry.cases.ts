import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import { OutboundCallLeaseState } from "../../infrastructure/execution-lease-event.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { EXPIRY_EDGE_OFFSET, EXPIRY_EDGES, ExpiryEdge } from "./execution-lease-expiry.cases.js";
import { keyOf, leaseOf, rejectionOf } from "./fenced-effect-data.js";
import { OUTBOUND_EXPIRY_WRITE_CASES } from "./outbound-call-expiry-writes.cases.js";
import { intentOf, type OutboundCallCase, type OutboundCallStores } from "./outbound-call-data.js";

/** The state of `stores`' lease of `execution-1` at `token`. */
const stateAt = (stores: OutboundCallStores, token: number) =>
  stores.calls.leaseStateOf({ tenantId: "default", leaseExecutionId: "execution-1", token });

/**
 * The holder records its call's intent at `edge`, nobody having taken the lease: 1 ms before the
 * expiry it is recorded; at the expiry and after it the lease is over (#534) — refused
 * (`ExecutionFencedError`), nothing recorded.
 */
const recordAt = (edge: ExpiryEdge): OutboundCallCase => {
  const isRecorded = edge === ExpiryEdge.Before;
  return {
    name: `#534: recording an intent ${edge}, the lease not taken meanwhile, ${isRecorded ? "is recorded" : "is refused: nothing recorded"}`,
    run: async ({ clock, first, second }) => {
      const key = keyOf(await leaseOf(first, "execution-1", seconds(30)));
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const saving = first.calls.saveIfAbsent(key, intentOf(key));

      if (isRecorded) {
        expect(await saving).toBe(true);
        expect(await second.calls.findByKey(key)).toMatchObject({ token: 1 });
        return;
      }
      expect(await rejectionOf(saving)).toBeInstanceOf(ExecutionFencedError);
      const next = await leaseOf(second, "execution-1", seconds(30));
      expect(await second.calls.findByKey(keyOf(next))).toBeUndefined();
    },
  };
};

/**
 * `leaseStateOf` at `edge` (#534): `Live` 1 ms before the expiry; at the expiry and after it the
 * lease is over — `Superseded` (closed by the check), then `Ended`, and its holder's renewal refused.
 */
const stateAtEdge = (edge: ExpiryEdge): OutboundCallCase => {
  const isLive = edge === ExpiryEdge.Before;
  return {
    name: `#534: leaseStateOf ${edge} is ${isLive ? "Live" : "Superseded, then Ended: the lease is over, its holder's renewal refused"}`,
    run: async ({ clock, first, second }) => {
      const lease = await leaseOf(first, "execution-1", seconds(30));
      await clock.advance(EXPIRY_EDGE_OFFSET[edge]);

      const state = await stateAt(second, lease.leaseEpoch);

      const { Live, Superseded, Ended } = OutboundCallLeaseState;
      expect(state).toBe(isLive ? Live : Superseded);
      expect(await stateAt(second, lease.leaseEpoch)).toBe(isLive ? Live : Ended);
      expect(await first.leases.renew(lease, seconds(30))).toBe(isLive);
    },
  };
};

/** The outbound-call store against the lease's boundary (#534): 1 ms before, exactly at, 1 ms after. */
export const outboundExpiryCases = (): ContractGroup<OutboundCallStores> => ({
  title: "the lease's expiry",
  cases: [
    ...EXPIRY_EDGES.map(recordAt),
    ...EXPIRY_EDGES.map(stateAtEdge),
    ...OUTBOUND_EXPIRY_WRITE_CASES,
  ],
});
