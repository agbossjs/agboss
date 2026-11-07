import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { EffectKey } from "../../infrastructure/fenced-effect.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallIntent,
  type OutboundCallRecord,
  type OutboundCallRepository,
} from "../../infrastructure/outbound-call.repository.js";
import type { ContractCase } from "./define.js";

/**
 * The target of the outbound-call contract (#505): one instance's outbound-call store and the lease
 * store of its database, whose leases it checks — and the data of the cases.
 */

/** One instance's stores on the backing database. */
export interface OutboundCallTarget {
  /** The store under test. */
  readonly calls: OutboundCallRepository;
  /** The lease store of the same database: the cases take and release leases in it. */
  readonly leases: ExecutionLeaseRepository;
}

/** One case of the contract. */
export type OutboundCallCase = ContractCase<OutboundCallTarget>;

/** The intent of `key`'s call, about to be sent for the first time. */
export const intentOf = (
  key: EffectKey,
  overrides: Partial<OutboundCallIntent> = {},
): OutboundCallIntent => ({
  rootExecutionId: key.leaseExecutionId,
  executionId: key.leaseExecutionId,
  workflow: "charge-workflow",
  target: "payments",
  operation: "charge",
  idempotencyKey: `${key.idempotencyKey}:${key.name}`,
  request: JSON.stringify({ orderId: "order-7", amountUsd: 10 }),
  attempt: 1,
  attemptOwner: "owner-1",
  step: { nodeId: "charge-action", visitNumber: 1 },
  ...overrides,
});

/** Records `key`'s intent through `stores`; a case fails when the key had one. */
export async function recorded(
  stores: OutboundCallTarget,
  key: EffectKey,
  overrides: Partial<OutboundCallIntent> = {},
): Promise<void> {
  if (!(await stores.calls.saveIfAbsent(key, intentOf(key, overrides))))
    throw new Error(`the intent of ${key.name} was recorded before`);
}

/** The most pages a case reads: its calls are a handful. */
const MAX_PAGES = 100;

/**
 * Every call of `tenantId` in `status` (#825), read page by page of `limit` from the cursor `from`
 * (none: the first) — the listing as a reader that follows `next` sees it.
 */
export async function listedOf(
  stores: OutboundCallTarget,
  status: OutboundCallStatus = OutboundCallStatus.Pending,
  tenantId = "default",
  limit = 1000,
  from?: string,
): Promise<readonly OutboundCallRecord[]> {
  const calls: OutboundCallRecord[] = [];
  const cursors = new Set<string>(from === undefined ? [] : [from]);
  let after = from;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await stores.calls.findAllByTenantIdAndStatus({ tenantId, status, limit, after });
    calls.push(...read.calls);
    if (read.next === undefined) return calls;
    // a cursor handed out twice is a listing that never ends: a failure, never a hang
    if (cursors.has(read.next))
      throw new Error(`findAllByTenantIdAndStatus handed out the cursor ${read.next} twice`);
    cursors.add(read.next);
    after = read.next;
  }
  throw new Error(`findAllByTenantIdAndStatus did not end its pages within ${String(MAX_PAGES)}`);
}
