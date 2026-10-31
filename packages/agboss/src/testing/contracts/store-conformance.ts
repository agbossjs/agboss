import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import type { CostLedgerRepository } from "../../infrastructure/cost-ledger.repository.js";
import type { ExecutionHistoryRepository } from "../../infrastructure/execution-history.repository.js";
import type { ExecutionLeaseEventRepository } from "../../infrastructure/execution-lease-event.repository.js";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { ExecutionRecordRepository } from "../../infrastructure/execution-record.repository.js";
import type { ExecutionTreeRepository } from "../../infrastructure/execution-tree.repository.js";
import type { MeshRequestRepository } from "../../infrastructure/mesh-request.repository.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { RateLimitRepository } from "../../infrastructure/rate-limit.repository.js";
import { checkpointSaverContract } from "./checkpoint-saver.contract.js";
import { childExecutionQueueContract } from "./child-execution-queue.contract.js";
import { costLedgerContract } from "./cost-ledger.contract.js";
import { executionHistoryContract } from "./execution-history.contract.js";
import { executionLeaseEventContract } from "./execution-lease-event.contract.js";
import { executionLeaseContract } from "./execution-lease.contract.js";
import { executionRecordContract } from "./execution-record.contract.js";
import { executionTreeContract } from "./execution-tree.contract.js";
import type { FencedEffectStores } from "./fenced-effect-data.js";
import { fencedEffectContract } from "./fenced-effect.contract.js";
import { meshRequestContract } from "./mesh-request.contract.js";
import type { OutboundCallStores } from "./outbound-call-data.js";
import { outboundCallContract } from "./outbound-call.contract.js";
import { pausedExecutionContract } from "./paused-execution.contract.js";
import { rateLimitContract } from "./rate-limit.contract.js";
import type { ContractTarget, StoreSeam } from "./seam.js";
import { checkStoreSet, type LeftOutContract } from "./store-conformance-check.js";
import { registerStoreSet } from "./store-set.cases.js";

/**
 * `storeConformance` (#526): one call that runs every contract a store set claims — the same
 * suites the core's in-memory and SQLite stores run, each as `<contract> (<name>)` — and the
 * `store set (<name>)` cases (each fencing store declares its backend, one with its lease store's).
 * A set with a lease store must give its fenced-effect, outbound-call and lease-log stores too, or
 * say it has none (`without`): a missing fencing contract fails the file, named
 * (`StoreConformanceError`), before any case runs.
 */

/** One store of the set: how one instance builds it, and optionally its own reset and close. */
export type ConformanceStore<TStore> =
  ((seam: StoreSeam) => TStore | Promise<TStore>) | Omit<ContractTarget<TStore>, "name">;

/** The stores a set claims, by contract: give each one the set has. */
export interface ConformanceStores<TTransaction = unknown> {
  readonly checkpointSaver?: ConformanceStore<BaseCheckpointSaver>;
  readonly childExecutionQueue?: ConformanceStore<ChildExecutionQueueRepository>;
  readonly costLedger?: ConformanceStore<CostLedgerRepository>;
  readonly executionHistory?: ConformanceStore<ExecutionHistoryRepository>;
  readonly executionLease?: ConformanceStore<ExecutionLeaseRepository>;
  readonly executionLeaseEvent?: ConformanceStore<ExecutionLeaseEventRepository>;
  readonly executionRecord?: ConformanceStore<ExecutionRecordRepository>;
  readonly executionTree?: ConformanceStore<ExecutionTreeRepository>;
  readonly fencedEffect?: ConformanceStore<FencedEffectStores<TTransaction>>;
  readonly meshRequest?: ConformanceStore<MeshRequestRepository>;
  readonly outboundCall?: ConformanceStore<OutboundCallStores>;
  readonly pausedExecution?: ConformanceStore<PausedExecutionRepository>;
  readonly rateLimit?: ConformanceStore<RateLimitRepository>;
}

/** A store set under test. */
export interface StoreConformanceOptions<TTransaction = unknown> {
  /** Shown in every suite's title: "PostgreSQL". */
  readonly name: string;
  /** Before each test of a store without a reset of its own: an empty backing store. */
  reset?(): void | Promise<void>;
  readonly stores: ConformanceStores<TTransaction>;
  /**
   * The fencing contracts a set with a lease store has no store of — a set of coordination stores
   * (leases, rate limits, the queue on Redis) says `["fencedEffect", "outboundCall"]`; an
   * application on these leases then lists none of them either (assembly refuses one of another
   * backend).
   */
  readonly without?: readonly LeftOutContract[];
  /**
   * A store of the set opts out of the atomic lease check (`LeaseCheck.WithoutDoubleChargeProtection`,
   * #543) and the caller says it knows: that store's fencing cases are skipped — never passed —
   * with "store opted out of the lease check: no double-charge protection", and the set shows
   * `gives NO double-charge protection for …`. Without it an opted-out store fails them
   * (`StoreConformanceError`). Such a store must never back payments.
   */
  readonly acceptWithoutDoubleChargeProtection?: boolean;
}

/** The target `storeConformance` hands a contract: the set's name, the store's own reset or the set's. */
function targetOf<TStore>(
  options: StoreConformanceOptions,
  store: ConformanceStore<TStore>,
): ContractTarget<TStore> {
  const own = typeof store === "function" ? { instance: store } : store;
  const reset = own.reset === undefined ? options.reset?.bind(options) : own.reset.bind(own);
  const close = own.close?.bind(own);
  return {
    name: options.name,
    instance: (seam) => own.instance(seam),
    ...(reset === undefined ? {} : { reset }),
    ...(close === undefined ? {} : { close }),
  };
}

/** Registers one contract's suite when the set gives its store. */
const each = <TStore>(
  options: StoreConformanceOptions,
  store: ConformanceStore<TStore> | undefined,
  register: (target: ContractTarget<TStore>) => void,
): ContractTarget<TStore> | undefined => {
  if (store === undefined) return undefined;
  const target = targetOf(options, store);
  register(target);
  return target;
};

/**
 * Runs, in its own vitest file, every contract `options.stores` claims and the store set's
 * cases; throws `StoreConformanceError` for a set whose fencing contracts do not hold together.
 */
export function storeConformance<TTransaction>(
  options: StoreConformanceOptions<TTransaction>,
): void {
  const set = options as StoreConformanceOptions;
  const { stores } = set;
  checkStoreSet({
    name: set.name,
    claimed: Object.entries(stores).flatMap(([key, store]) => (store === undefined ? [] : [key])),
    without: set.without ?? [],
  });
  each(set, stores.checkpointSaver, checkpointSaverContract);
  each(set, stores.childExecutionQueue, childExecutionQueueContract);
  each(set, stores.costLedger, costLedgerContract);
  each(set, stores.executionHistory, executionHistoryContract);
  const executionLease = each(set, stores.executionLease, executionLeaseContract);
  each(set, stores.executionLeaseEvent, executionLeaseEventContract);
  each(set, stores.executionRecord, executionRecordContract);
  each(set, stores.executionTree, executionTreeContract);
  const fencing = { acceptWithoutDoubleChargeProtection: set.acceptWithoutDoubleChargeProtection };
  const fencedEffect = each(set, stores.fencedEffect, (target) => {
    fencedEffectContract(target, fencing);
  });
  each(set, stores.meshRequest, meshRequestContract);
  const outboundCall = each(set, stores.outboundCall, (target) => {
    outboundCallContract(target, fencing);
  });
  each(set, stores.pausedExecution, pausedExecutionContract);
  each(set, stores.rateLimit, rateLimitContract);
  registerStoreSet(
    set.name,
    { executionLease, fencedEffect, outboundCall },
    { isAccepted: set.acceptWithoutDoubleChargeProtection === true },
  );
}
