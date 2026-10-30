import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import type {
  OutboundCallIntent,
  OutboundCallRepository,
} from "../../infrastructure/outbound-call.repository.js";
import type { ContractCase } from "./define.js";

/**
 * The seam of the outbound-call contract (#505): one instance's outbound-call store and the lease
 * store of its database, whose leases it checks — and the data of the cases.
 */

/** One instance's stores on the backing database. */
export interface OutboundCallStores {
  /** The store under test. */
  readonly calls: OutboundCallRepository;
  /** The lease store of the same database: the cases take and release leases in it. */
  readonly leases: ExecutionLeaseRepository;
}

/** One case of the contract. */
export type OutboundCallCase = ContractCase<OutboundCallStores>;

/** The intent of `key`'s call, about to be sent for the first time. */
export const intentOf = (
  key: FencedEffectKey,
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
  stores: OutboundCallStores,
  key: FencedEffectKey,
  overrides: Partial<OutboundCallIntent> = {},
): Promise<void> {
  if (!(await stores.calls.saveIfAbsent(key, intentOf(key, overrides))))
    throw new Error(`the intent of ${key.name} was recorded before`);
}
