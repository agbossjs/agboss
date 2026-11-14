import { expect } from "vitest";
import { ExecutionCancelFencedError, ExecutionFencedError } from "../../app/lease-lost.js";
import {
  OutboundCallStatus,
  type OutboundCallState,
} from "../../infrastructure/outbound-call.repository.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { ContractGroup } from "./define.js";
import { effectKeyForTesting } from "./effect-key.js";
import { keyOf, leaseOf, rejectionOf } from "./fenced-effect-data.js";
import {
  intentOf,
  listedOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallTarget,
} from "./outbound-call-data.js";

/**
 * The cancel as a fence of the outbound call (#909): once a tree's cancel request is durable
 * (`ExecutionLeaseRepository.requestCancel`), no new send starts under it — `saveIfAbsent` (a new
 * intent) and `markPending` (a new attempt) are refused with `ExecutionCancelFencedError`, nothing
 * recorded or claimed, so nothing can be sent. What ends or reads an attempt that was claimed before
 * is accepted — `markCompleted`, `markFailed`, `findByKey`: refusing them would lose what happened.
 */

const FAILURE = { name: "PaymentDeclinedError", code: "PaymentDeclinedError", message: "declined" };

/** A failed first attempt of owner `owner-1`, as a caller reads it. */
const FAILED: OutboundCallState = {
  status: OutboundCallStatus.Failed,
  attempt: 1,
  attemptOwner: "owner-1",
};

/** The tree `lease` belongs to, as `requestCancel` names it. */
const treeOf = (lease: ExecutionLease) => ({
  tenantId: lease.tenantId,
  rootExecutionId: lease.rootExecutionId,
});

const saveRefused: OutboundCallCase = {
  name: "#909 AC1: saveIfAbsent after its tree's durable cancel is refused — ExecutionCancelFencedError, nothing recorded, so nothing can be sent",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const key = keyOf(lease);
    await second.leases.requestCancel(treeOf(lease));

    const refused = await rejectionOf(first.calls.saveIfAbsent(key, intentOf(key)));

    expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
    expect(refused).not.toBeInstanceOf(ExecutionFencedError);
    expect(refused).toMatchObject({ code: "execution.cancelled.fenced", effect: "charge" });
    expect(await first.calls.findByKey(key)).toBeUndefined();
    expect(await listedOf(first)).toEqual([]);
  },
};

const markPendingRefused: OutboundCallCase = {
  name: "#909 AC1: markPending after the cancel is refused, the intent unchanged — no new attempt, so no send; findByKey still answers it",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const key = keyOf(lease);
    await recorded(first, key);
    await first.calls.markFailed(key, "owner-1", FAILURE);
    await second.leases.requestCancel(treeOf(lease));

    const refused = await rejectionOf(
      first.calls.markPending(key, FAILED, { attempt: 2, attemptOwner: "owner-2" }),
    );

    expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
    expect(await second.calls.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Failed,
      attempt: 1,
      attemptOwner: "owner-1",
    });
  },
};

const attemptEndsAfterCancel: OutboundCallCase = {
  name: "#909: markCompleted and markFailed of an attempt claimed before the cancel are accepted — they record what happened — and findByKey answers",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const sent = keyOf(lease, "charge", "execution-1:sent:1");
    const declined = keyOf(lease, "refund", "execution-1:declined:1");
    await recorded(first, sent);
    await recorded(first, declined);
    await second.leases.requestCancel(treeOf(lease));

    const isCompleted = await first.calls.markCompleted(sent, "owner-1", '{"receipt":"r1"}');
    const isFailed = await first.calls.markFailed(declined, "owner-1", FAILURE);

    expect([isCompleted, isFailed]).toEqual([true, true]);
    expect(await second.calls.findByKey(sent)).toMatchObject({
      status: OutboundCallStatus.Completed,
      result: '{"receipt":"r1"}',
    });
    expect(await second.calls.findByKey(declined)).toMatchObject({
      status: OutboundCallStatus.Failed,
    });
  },
};

const undoPasses: OutboundCallCase = {
  name: "#909: an undo's key (isCompensation) records, claims and ends its call after the cancel",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    await second.leases.requestCancel(treeOf(lease));
    const undo = effectKeyForTesting(keyOf(lease, "refund", "execution-1:charge:1:compensation"), {
      isCompensation: true,
    });

    expect(await first.calls.saveIfAbsent(undo, intentOf(undo))).toBe(true);
    await first.calls.markFailed(undo, "owner-1", FAILURE);
    expect(await first.calls.markPending(undo, FAILED, { attempt: 2, attemptOwner: "o2" })).toBe(
      true,
    );
  },
};

const otherTreesUntouched: OutboundCallCase = {
  name: "#909: a cancel of another tree or another tenant's tree refuses nothing; a child's key is refused by its root's cancel",
  isFencing: true,
  run: async ({ first, second }) => {
    const mine = await leaseOf(first, "execution-1");
    const child = await leaseOf(first, "child-1");
    await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-2" });
    await second.leases.requestCancel({ tenantId: "acme", rootExecutionId: "execution-1" });
    await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "root-1" });

    const ownKey = keyOf(mine);
    const childKey = effectKeyForTesting(keyOf(child), { rootExecutionId: "root-1" });
    const refused = await rejectionOf(first.calls.saveIfAbsent(childKey, intentOf(childKey)));

    expect(await first.calls.saveIfAbsent(ownKey, intentOf(ownKey))).toBe(true);
    expect(refused).toMatchObject({ rootExecutionId: "root-1", leaseExecutionId: "child-1" });
  },
};

const staleTokenIsHandOver: OutboundCallCase = {
  name: "#909: a stale token after a cancel is ExecutionFencedError, not the cancel",
  isFencing: true,
  run: async ({ first, second }) => {
    const old = await leaseOf(first);
    await first.leases.release(old);
    const taken = await leaseOf(second);
    await second.leases.requestCancel(treeOf(taken));
    const key = keyOf(old);

    const zombie = await rejectionOf(first.calls.saveIfAbsent(key, intentOf(key)));
    const holder = await rejectionOf(second.calls.saveIfAbsent(keyOf(taken), intentOf(key)));

    expect(zombie).toBeInstanceOf(ExecutionFencedError);
    expect(holder).toBeInstanceOf(ExecutionCancelFencedError);
  },
};

const cancelBeforeFirstAcquire: OutboundCallCase = {
  name: "#909 AC1: a cancel before the tree's first acquire refuses the call of the lease taken after it",
  isFencing: true,
  run: async ({ first, second }) => {
    await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-1" });
    const key = keyOf(await leaseOf(first));

    const refused = await rejectionOf(first.calls.saveIfAbsent(key, intentOf(key)));

    expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
  },
};

/** The cancel as a fence of the outbound call. */
export const outboundCancelCases = (): ContractGroup<OutboundCallTarget> => ({
  title: "a tree's cancel is a fence (#909)",
  cases: [
    saveRefused,
    markPendingRefused,
    attemptEndsAfterCancel,
    undoPasses,
    otherTreesUntouched,
    staleTokenIsHandOver,
    cancelBeforeFirstAcquire,
  ],
});
