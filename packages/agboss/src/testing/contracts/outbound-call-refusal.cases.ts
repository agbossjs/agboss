import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import { hours, seconds } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf, rejectionOf } from "./fenced-effect-data.js";
import {
  intentOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallStores,
} from "./outbound-call-data.js";

/**
 * The outbound-call contract's refusals (#505 AC5): every fenced method of a stale token, a
 * released or an expired lease is refused with `ExecutionFencedError` and changes nothing; the
 * listings by tree and by status; the retention cutoff, which never removes a pending intent.
 */

/** Each fenced method, called with `key`. */
const FENCED_CALLS: readonly (readonly [
  string,
  (stores: OutboundCallStores, key: FencedEffectKey) => Promise<unknown>,
])[] = [
  ["findByKey", (stores, key) => stores.calls.findByKey(key)],
  [
    "saveIfAbsent",
    (stores, key) => stores.calls.saveIfAbsent({ ...key, name: "other" }, intentOf(key)),
  ],
  [
    "markPending",
    (stores, key) =>
      stores.calls.markPending(
        key,
        { status: OutboundCallStatus.Pending, attempt: 1, token: 1 },
        2,
      ),
  ],
  ["markCompleted", (stores, key) => stores.calls.markCompleted(key, '"zombie"')],
  [
    "markFailed",
    (stores, key) =>
      stores.calls.markFailed(key, { name: "Error", code: "Error", message: "zombie" }),
  ],
];

const staleTokenRefused = ([method, call]: (typeof FENCED_CALLS)[number]): OutboundCallCase => ({
  name: `AC5: ${method} with a token below the lease's after a takeover is refused and changes nothing`,
  run: async ({ clock, first, second }) => {
    const old = await leaseOf(first, "execution-1", seconds(30));
    await recorded(first, keyOf(old));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1", seconds(30));
    await second.calls.findByKey(keyOf(taken));

    const refused = await rejectionOf(call(first, keyOf(old)));

    expect(refused).toBeInstanceOf(ExecutionFencedError);
    expect(refused).toMatchObject({ token: 1, observedToken: 2 });
    expect(await second.calls.findByKey(keyOf(taken))).toMatchObject({
      status: OutboundCallStatus.Pending,
      attempt: 1,
      token: 1,
    });
    expect(await second.calls.findByKey(keyOf(taken, "other"))).toBeUndefined();
  },
});

const releasedRefused: OutboundCallCase = {
  name: "AC5: a released lease is refused before anything is recorded",
  run: async ({ first }) => {
    const lease = await leaseOf(first);
    await first.leases.release(lease);

    const refused = await rejectionOf(
      first.calls.saveIfAbsent(keyOf(lease), intentOf(keyOf(lease))),
    );

    expect(refused).toBeInstanceOf(ExecutionFencedError);
    expect(
      await first.calls.findAllByTenantIdAndStatus("default", OutboundCallStatus.Pending),
    ).toEqual([]);
  },
};

const expiredRefused: OutboundCallCase = {
  name: "AC5: an expired lease nobody took yet is refused too",
  run: async ({ clock, first }) => {
    const lease = await leaseOf(first, "execution-1", seconds(30));
    await clock.advance(seconds(31));

    const refused = await rejectionOf(first.calls.findByKey(keyOf(lease)));

    expect(refused).toBeInstanceOf(ExecutionFencedError);
  },
};

const listedByTree: OutboundCallCase = {
  name: "AC4: the calls of one tree in the order recorded — another tree's and another tenant's apart",
  run: async ({ first, second }) => {
    const tree = await leaseOf(first, "execution-1");
    const other = await leaseOf(first, "execution-2");
    const tenant = await leaseOf(first, "execution-1", hours(1), "acme");
    await recorded(first, keyOf(tree, "charge"));
    await recorded(first, keyOf(other, "charge"));
    await recorded(second, keyOf(tree, "notify"));
    await recorded(first, keyOf(tenant, "charge"));

    const calls = await second.calls.findAllByTenantIdAndRootExecutionId("default", "execution-1");

    expect(calls.map((call) => call.name)).toEqual(["charge", "notify"]);
  },
};

const listedByStatus: OutboundCallCase = {
  name: "AC3: a tenant's pending calls — the completed and failed ones apart",
  run: async ({ first }) => {
    const lease = await leaseOf(first);
    for (const name of ["pending", "completed", "failed"])
      await recorded(first, keyOf(lease, name));
    await first.calls.markCompleted(keyOf(lease, "completed"), "{}");
    await first.calls.markFailed(keyOf(lease, "failed"), {
      name: "Error",
      code: "Error",
      message: "no",
    });

    const pending = await first.calls.findAllByTenantIdAndStatus(
      "default",
      OutboundCallStatus.Pending,
    );
    const failed = await first.calls.findAllByTenantIdAndStatus(
      "default",
      OutboundCallStatus.Failed,
    );

    expect(pending.map((call) => call.name)).toEqual(["pending"]);
    expect(failed.map((call) => call.name)).toEqual(["failed"]);
    expect(
      await first.calls.findAllByTenantIdAndStatus("acme", OutboundCallStatus.Pending),
    ).toEqual([]);
  },
};

const retentionKeepsPending: OutboundCallCase = {
  name: "the retention cutoff on the Clock removes ended intents before it and never a pending one",
  run: async ({ clock, first, second }) => {
    const lease = await leaseOf(first, "execution-1", hours(100));
    for (const name of ["pending", "early", "late"]) await recorded(first, keyOf(lease, name));
    await first.calls.markCompleted(keyOf(lease, "early"), "{}");
    await clock.advance(hours(2));
    await first.calls.markFailed(keyOf(lease, "late"), {
      name: "Error",
      code: "Error",
      message: "no",
    });

    await second.calls.deleteByEndedAtBefore(new Date(clock.now().getTime() - hours(1)));

    const left = await first.calls.findAllByTenantIdAndRootExecutionId("default", "execution-1");
    expect(left.map((call) => call.name)).toEqual(["pending", "late"]);
  },
};

/** The fencing refusals. */
export const outboundRefusalCases = (): ContractGroup<OutboundCallStores> => ({
  title: "refusals",
  cases: [...FENCED_CALLS.map(staleTokenRefused), releasedRefused, expiredRefused],
});

/** The listings and the retention. */
export const outboundListingCases = (): ContractGroup<OutboundCallStores> => ({
  title: "listings and retention",
  cases: [listedByTree, listedByStatus, retentionKeepsPending],
});
