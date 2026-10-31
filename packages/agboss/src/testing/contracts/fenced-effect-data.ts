import { scopeKeyOf } from "../../app/lease-lost.js";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import type {
  FencedEffectKey,
  FencedEffectRepository,
  FencedEffectWork,
} from "../../infrastructure/fenced-effect.repository.js";
import { hours, type Milliseconds } from "../../units/index.js";

/**
 * The seam of the fenced-effect contract (#500): what one instance's fenced-effect store works
 * with — the lease store of the same database, whose leases it checks, and business rows written
 * in its transaction — and the data of its cases.
 */

/** How a case writes a business row in the effect's transaction and reads the committed ones. */
export interface FencedEffectBusinessRows<TTransaction> {
  /**
   * Writes `row` in `transaction` — synchronously (`undefined`) for a store whose work must be, a
   * promise for one whose work may wait.
   */
  insert(transaction: TTransaction, row: string): void | Promise<void>;
  /** The rows committed so far, as another connection sees them, read when called. */
  committed(): Promise<readonly string[]>;
}

/**
 * One instance's stores on the backing database: the fenced-effect store under test, built with
 * the default `FencedEffectSettings` (64 KB), the lease store it reads, and the business rows.
 */
export interface FencedEffectStores<TTransaction> {
  /** The store under test. */
  readonly effects: FencedEffectRepository<TTransaction>;
  /** The lease store of the same database: the cases take and release leases in it. */
  readonly leases: ExecutionLeaseRepository;
  /** The business rows its writes insert. */
  readonly rows: FencedEffectBusinessRows<TTransaction>;
}

/** What a case's write gives: the receipt of the row it wrote. */
export interface Receipt {
  readonly receipt: string;
}

/** How many times a case's writes ran. */
export interface WriteCount {
  runs: number;
}

/** A tree's lease long enough for a case (an hour of the case's clock). */
export const CASE_LEASE: Milliseconds = hours(1);

/** Stores whose cases take leases: the lease store of their database. */
export interface LeaseHoldingStores {
  readonly leases: ExecutionLeaseRepository;
}

/** The lease of `executionId` for `length`, taken by `stores`' instance; a case fails without it. */
export async function leaseOf(
  stores: LeaseHoldingStores,
  executionId = "execution-1",
  length: Milliseconds = CASE_LEASE,
  tenantId = "default",
): Promise<ExecutionLease> {
  const lease = await stores.leases.acquire(tenantId, executionId, length);
  if (lease === undefined)
    throw new Error(`the lease of ${executionId} is held by another instance`);
  return lease;
}

/** The key of effect `name` of a step, under `lease`. */
export const keyOf = (
  lease: ExecutionLease,
  name = "charge",
  idempotencyKey = `${lease.rootExecutionId}:charge-action:1`,
): FencedEffectKey => ({
  scopeKey: scopeKeyOf(lease.tenantId, lease.rootExecutionId),
  tenantId: lease.tenantId,
  leaseExecutionId: lease.rootExecutionId,
  token: lease.leaseEpoch,
  idempotencyKey,
  name,
});

/**
 * The key of `lease`'s step under business key `order:42`, with `fingerprint` (`null`: none — the
 * empty text is a fingerprint, #574).
 */
export const businessKeyOf = (
  lease: ExecutionLease,
  fingerprint: string | null = "fingerprint-a",
  step = `${lease.rootExecutionId}:charge-action:1`,
): FencedEffectKey => ({
  ...keyOf(lease, "charge", step),
  businessKey: "order:42",
  ...(fingerprint === null ? {} : { fingerprint }),
  origin: { executionId: lease.rootExecutionId, nodeId: "charge-action", visitNumber: 1 },
});

/** A write that inserts `row` and gives its receipt, counted in `count`. */
export const writing =
  <TTransaction>(
    rows: FencedEffectBusinessRows<TTransaction>,
    row: string,
    count: WriteCount,
  ): FencedEffectWork<TTransaction, Receipt> =>
  (transaction) => {
    count.runs += 1;
    const inserted = rows.insert(transaction, row);
    const receipt: Receipt = { receipt: row };
    return inserted === undefined ? receipt : inserted.then(() => receipt);
  };

/** A write that inserts `row`, then throws `error` (a declined card): nothing may stay. */
export const failing =
  <TTransaction>(
    rows: FencedEffectBusinessRows<TTransaction>,
    row: string,
    error: Error,
  ): FencedEffectWork<TTransaction, Receipt> =>
  (transaction) => {
    const inserted = rows.insert(transaction, row);
    if (inserted === undefined) throw error;
    return inserted.then(() => Promise.reject(error));
  };

/** What a call rejected with; a case fails when it resolved. */
export const rejectionOf = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("the call resolved: it should have been refused");
};
