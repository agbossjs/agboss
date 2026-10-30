import { expect } from "vitest";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import {
  intentOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallStores,
} from "./outbound-call-data.js";

/**
 * The outbound-call contract's business keys (#508): one intent per tenant, name and business key,
 * whatever execution records it — read and settled by another execution's key, which the record
 * then names — and `isLeaseHeld`, what tells a live holder of a pending intent from a dead one.
 */

/** `lease`'s step key under business key `order:42`. */
const businessKeyOf = (lease: ExecutionLease): FencedEffectKey => ({
  ...keyOf(lease),
  businessKey: "order:42",
  fingerprint: "fingerprint-a",
});

const oneAcrossExecutions: OutboundCallCase = {
  name: "#508: a business key's intent is one row: another execution's key finds it, with its business key, fingerprint and holder, and cannot save a second",
  run: async ({ first, second }) => {
    const key = businessKeyOf(await leaseOf(first, "execution-1"));
    await recorded(first, key);
    const other = businessKeyOf(await leaseOf(second, "execution-2"));

    const found = await second.calls.findByKey(other);
    const isSaved = await second.calls.saveIfAbsent(other, intentOf(other));

    expect(found).toMatchObject({
      rootExecutionId: "execution-1",
      businessKey: "order:42",
      fingerprint: "fingerprint-a",
      leaseExecutionId: "execution-1",
      status: OutboundCallStatus.Pending,
    });
    expect(isSaved).toBe(false);
  },
};

const settledByAnother: OutboundCallCase = {
  name: "#508: another execution settles a business key's intent under its own lease: the record names its token and holder",
  run: async ({ first, second }) => {
    await recorded(first, businessKeyOf(await leaseOf(first, "execution-1")));
    const other = businessKeyOf(await leaseOf(second, "execution-2"));

    await second.calls.markCompleted(other, "owner-1", '{"receipt":"r1"}');

    expect(await first.calls.findByKey(other)).toMatchObject({
      status: OutboundCallStatus.Completed,
      result: '{"receipt":"r1"}',
      leaseExecutionId: "execution-2",
      token: 1,
    });
  },
};

const stepKeyApart: OutboundCallCase = {
  name: "#508: a step's own key and a business key are two intents; a step key's record has no business key",
  run: async ({ first }) => {
    const lease = await leaseOf(first);
    await recorded(first, keyOf(lease));

    const isSaved = await first.calls.saveIfAbsent(
      businessKeyOf(lease),
      intentOf(businessKeyOf(lease)),
    );
    const found = await first.calls.findByKey(keyOf(lease));

    expect(isSaved).toBe(true);
    expect(found).not.toHaveProperty("businessKey");
    expect(found).not.toHaveProperty("fingerprint");
  },
};

const tenantsApart: OutboundCallCase = {
  name: "#508: one business key in two tenants is two intents",
  run: async ({ first }) => {
    await recorded(first, businessKeyOf(await leaseOf(first, "execution-1", undefined, "acme")));
    const other = businessKeyOf(await leaseOf(first, "execution-1", undefined, "globex"));

    expect(await first.calls.findByKey(other)).toBeUndefined();
  },
};

const heldLease: OutboundCallCase = {
  name: "#508: isLeaseHeld is true for the lease's current token, on either instance",
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);

    expect(await first.calls.isLeaseHeld("default", "execution-1", lease.leaseEpoch)).toBe(true);
    expect(await second.calls.isLeaseHeld("default", "execution-1", lease.leaseEpoch)).toBe(true);
  },
};

const deadLease: OutboundCallCase = {
  name: "#508: isLeaseHeld is false for a released lease, an expired one, an older token after a takeover and a lease never taken",
  run: async ({ clock, first, second }) => {
    const released = await leaseOf(first, "execution-1");
    await first.leases.release(released);
    const expired = await leaseOf(first, "execution-2", seconds(30));
    const old = await leaseOf(first, "execution-3", seconds(30));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-3");

    expect(await first.calls.isLeaseHeld("default", "execution-1", released.leaseEpoch)).toBe(
      false,
    );
    expect(await first.calls.isLeaseHeld("default", "execution-2", expired.leaseEpoch)).toBe(false);
    expect(await first.calls.isLeaseHeld("default", "execution-3", old.leaseEpoch)).toBe(false);
    expect(await first.calls.isLeaseHeld("default", "execution-3", taken.leaseEpoch)).toBe(true);
    expect(await first.calls.isLeaseHeld("default", "execution-9", 1)).toBe(false);
  },
};

/** The business-key cases. */
export const outboundBusinessKeyCases = (): ContractGroup<OutboundCallStores> => ({
  title: "business keys",
  cases: [oneAcrossExecutions, settledByAnother, stepKeyApart, tenantsApart, heldLease, deadLease],
});
