import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import type { CostLedgerRepository } from "../../infrastructure/cost-ledger.repository.js";
import type { ExecutionHistoryRepository } from "../../infrastructure/execution-history.repository.js";
import type { ExecutionLeaseEventRepository } from "../../infrastructure/execution-lease-event.repository.js";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { ExecutionRecordRepository } from "../../infrastructure/execution-record.repository.js";
import type { ExecutionTreeRepository } from "../../infrastructure/execution-tree.repository.js";
import type { MeshRequestRepository } from "../../infrastructure/mesh-request.repository.js";
import type { A2ATaskRepository } from "../../infrastructure/a2a-task.repository.js";
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
import type { FencedEffectTarget } from "./fenced-effect-data.js";
import { registerFencedEffectContract } from "./fenced-effect.contract.js";
import { optOutOf } from "./fencing-gate.js";
import { meshRequestContract } from "./mesh-request.contract.js";
import { a2aTaskContract } from "./a2a-task.contract.js";
import type { OutboundCallTarget } from "./outbound-call-data.js";
import { registerOutboundCallContract } from "./outbound-call.contract.js";
import { pausedExecutionContract } from "./paused-execution.contract.js";
import { rateLimitContract } from "./rate-limit.contract.js";
import type { ContractTarget, StoreInstanceContext } from "./instance-context.js";
import { checkStoreSet, type LeftOutContract } from "./store-conformance-check.js";
import { registerInterleavings, type InterleavingOptions } from "./explorer/register.js";
import { registerInterleavingsOff } from "./explorer/floor.js";
import { registerStoreSet } from "./store-set.cases.js";
import type { StoreCapability } from "./store-capability.js";

/**
 * `storeConformance` (#526): one call that runs every contract a store set claims — the same
 * suites the core's in-memory and SQLite stores run, each as `<contract> (<name>)` — and the
 * `store set (<name>)` cases (each fencing store declares its backend, one with its lease store's).
 * A set with a lease store must give its fenced-effect, outbound-call and lease-log stores too, or
 * say it has none (`without`): a missing fencing contract fails the file, named
 * (`StoreConformanceError`), before any case runs.
 */

/** One store of the set: how one instance builds it, and optionally its own reset and close. */
export type StoreEntry<TStore> =
  ((context: StoreInstanceContext) => TStore | Promise<TStore>) | Omit<ContractTarget<TStore>, "name">;

/** The stores a set claims, by contract: give each one the set has. */
export interface StoreSet<TTransaction = unknown> {
  readonly checkpointSaver?: StoreEntry<BaseCheckpointSaver>;
  readonly childExecutionQueue?: StoreEntry<ChildExecutionQueueRepository>;
  readonly costLedger?: StoreEntry<CostLedgerRepository>;
  readonly executionHistory?: StoreEntry<ExecutionHistoryRepository>;
  readonly executionLease?: StoreEntry<ExecutionLeaseRepository>;
  readonly executionLeaseEvent?: StoreEntry<ExecutionLeaseEventRepository>;
  readonly executionRecord?: StoreEntry<ExecutionRecordRepository>;
  readonly executionTree?: StoreEntry<ExecutionTreeRepository>;
  readonly fencedEffect?: StoreEntry<FencedEffectTarget<TTransaction>>;
  readonly meshRequest?: StoreEntry<MeshRequestRepository>;
  /** The A2A tasks (#807). */
  readonly a2aTask?: StoreEntry<A2ATaskRepository>;
  readonly outboundCall?: StoreEntry<OutboundCallTarget>;
  readonly pausedExecution?: StoreEntry<PausedExecutionRepository>;
  readonly rateLimit?: StoreEntry<RateLimitRepository>;
}

/** A store set under test. */
export interface StoreConformanceOptions<TTransaction = unknown> {
  /** Shown in every suite's title: "PostgreSQL". */
  readonly name: string;
  /** Before each test of a store without a reset of its own: an empty backing store. */
  reset?(): void | Promise<void>;
  readonly stores: StoreSet<TTransaction>;
  /**
   * The fencing contracts a set with a lease store has no store of — a set of coordination stores
   * (leases, rate limits, the queue on Redis) says `["fencedEffect", "outboundCall"]`; an
   * application on these leases then lists none of them either (assembly refuses one of another
   * backend). The interleaving explorer then runs on the lease store alone (#694).
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
  /**
   * The interleaving explorer's budget (#533): how deep it searches every schedule and how many
   * seeded walks it takes over the set's fencing stores. Default: 8 steps, 200 walks of 30 steps.
   * Each count is a whole number of at least 1, else the set is refused (#799,
   * `[store-conformance.invalid-interleavings]`). A set with a fenced-effect or outbound-call store
   * runs at least depth 4, 20 walks of 16 steps, else its `store set (<name>)` case
   * `explores its fencing stores at least at the floor …` fails. `false` leaves the explorer out:
   * `interleavings (<name>)` shows one skipped case, and a set with fencing stores fails that floor
   * case — only a set of leases alone (`without` both) may turn it off.
   */
  readonly interleavings?: InterleavingOptions | false;
}

/** The target `storeConformance` hands a contract: the set's name, the store's own reset or the set's. */
function targetOf<TStore>(
  options: StoreConformanceOptions,
  store: StoreEntry<TStore>,
): ContractTarget<TStore> {
  const own = typeof store === "function" ? { instance: store } : store;
  const reset = own.reset === undefined ? options.reset?.bind(options) : own.reset.bind(own);
  const close = own.close?.bind(own);
  const capabilities: unknown = Reflect.get(own, "capabilities");
  return {
    name: options.name,
    instance: (context) => own.instance(context),
    ...(reset === undefined ? {} : { reset }),
    ...(close === undefined ? {} : { close }),
    // as given: the contract checks it (#831)
    ...(capabilities === undefined
      ? {}
      : { capabilities: capabilities as readonly StoreCapability[] }),
  };
}

/** Registers one contract's suite when the set gives its store. */
const each = <TStore>(
  options: StoreConformanceOptions,
  store: StoreEntry<TStore> | undefined,
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
  const claimed = Object.entries(stores).flatMap(([key, store]) =>
    store === undefined ? [] : [key],
  );
  const without = set.without ?? [];
  checkStoreSet({ name: set.name, claimed, without, interleavings: set.interleavings });
  each(set, stores.checkpointSaver, checkpointSaverContract);
  each(set, stores.childExecutionQueue, childExecutionQueueContract);
  each(set, stores.costLedger, costLedgerContract);
  each(set, stores.executionHistory, executionHistoryContract);
  const executionLease = each(set, stores.executionLease, executionLeaseContract);
  each(set, stores.executionLeaseEvent, executionLeaseEventContract);
  each(set, stores.executionRecord, executionRecordContract);
  each(set, stores.executionTree, executionTreeContract);
  // the set's own suite shows an opt-out (#543): its contracts do not show it again
  const fencing = optOutOf(set, false);
  const fencedEffect = each(set, stores.fencedEffect, (target) => {
    registerFencedEffectContract(target, fencing);
  });
  each(set, stores.meshRequest, meshRequestContract);
  each(set, stores.a2aTask, a2aTaskContract);
  const outboundCall = each(set, stores.outboundCall, (target) => {
    registerOutboundCallContract(target, fencing);
  });
  each(set, stores.pausedExecution, pausedExecutionContract);
  each(set, stores.rateLimit, rateLimitContract);
  const interleavings = executionLease === undefined ? undefined : (set.interleavings ?? {});
  registerStoreSet(
    set.name,
    { executionLease, fencedEffect, outboundCall },
    { isAccepted: set.acceptWithoutDoubleChargeProtection === true },
    { claimed, without, interleavings },
  );
  // #799: an explorer turned off is a skipped case, never nothing
  if (executionLease !== undefined && set.interleavings === false)
    registerInterleavingsOff(set.name);
  else if (executionLease !== undefined)
    registerInterleavings(
      set.name,
      { executionLease, fencedEffect, outboundCall },
      {
        ...set.interleavings,
        isOptOutAccepted: set.acceptWithoutDoubleChargeProtection === true,
      },
    );
}
