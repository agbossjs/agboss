import { depsOf } from "../../components/container/container.js";
import { Injectable } from "../../components/decorators.js";
import type { Class, Token } from "../../components/injection.js";
import {
  ExecutionAuditEventKind,
  ExecutionAuditLogRepository,
} from "../../infrastructure/execution-audit-log.repository.js";
import type { EffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { systemClock } from "../../infrastructure/clock.js";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
import { seconds } from "../../units/index.js";
import { effectKeyForTesting } from "../contracts/effect-key.js";
import { FaultStoreSabotage } from "./pod-protocol.js";
import { FENCED_EFFECT_METHODS, LEASE_METHODS, type StoreMethod } from "./store-points.js";

/**
 * #959 AC5 — a store sabotage every set runs: the set's own fenced-effect store, let through a
 * stale token at the lease's current epoch (no fencing check, as 5b's `Unfenced…` stores) and its
 * pod SIGKILLed before the answer, so the store's row keeps the write at the epoch it was let
 * through at and only the history's unanswered invoke tells whose it was (#876). The current epoch
 * is read from the audit log's takeover rows — the same on every store, whatever its backend.
 */

/** The lease's current epoch of `key`: the highest takeover of its tree, 1 before any. */
async function currentEpochOf(audit: ExecutionAuditLogRepository, key: EffectKey): Promise<number> {
  const rows = await audit.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    key.tenantId,
    key.leaseExecutionId,
  );
  return rows.reduce(
    (epoch, row) =>
      row.kind === ExecutionAuditEventKind.Takeover ? Math.max(epoch, row.token) : epoch,
    key.token,
  );
}

/** A listed store class, extended as the concrete class it is (its type may be the abstract contract). */
const concreteOf = (store: Class): new (...args: unknown[]) => object =>
  store as new (...args: unknown[]) => object;

type RunInTransaction = (this: object, key: EffectKey, work: unknown) => Promise<unknown>;

/**
 * `store` (a fenced-effect store class) that lets a stale token through at the current epoch and
 * kills its process before it answers; named `Sabotaged<Store>`. Its extra dependency is the
 * application's audit log, last.
 */
export function staleThenKilled<TStore extends Class>(store: TStore): TStore {
  const Concrete = concreteOf(store);
  const original: unknown = Reflect.get(store.prototype, "runInTransaction");
  if (typeof original !== "function")
    throw new TypeError(`${store.name} has no runInTransaction: it is not a fenced-effect store`);
  const base = original as RunInTransaction;
  const count = depsOf(store).length;
  const sabotaged = class extends Concrete {
    readonly #audit: ExecutionAuditLogRepository;
    constructor(...args: unknown[]) {
      super(...args.slice(0, count));
      const audit = args[count];
      if (!(audit instanceof ExecutionAuditLogRepository))
        throw new TypeError(`${store.name}: the sabotage needs the application's audit log`);
      this.#audit = audit;
    }
    async runInTransaction(key: EffectKey, work: unknown): Promise<unknown> {
      const current = await currentEpochOf(this.#audit, key);
      const outcome = await base.call(this, effectKeyForTesting(key, { token: current }), work);
      if (key.token < current) process.kill(process.pid, "SIGKILL");
      return outcome;
    }
  };
  Object.defineProperty(sabotaged, "name", { value: `Sabotaged${store.name}` });
  const deps: readonly Token[] = [...depsOf(store), ExecutionAuditLogRepository];
  Injectable({ deps: deps as [] })(sabotaged);
  const typed: unknown = sabotaged;
  return typed as TStore;
}

/** How long the sabotage waits for the store before it answers `Ran`: far below any lease's trust. */
const GIVES_UP_AFTER = seconds(0.5);

/**
 * `store` (a fenced-effect store class) that answers `Ran` when the write it asked of its own
 * (held) store does not answer within `GIVES_UP_AFTER` (#928 S2b): an unknown outcome taken for
 * done, below the framework's bound — which therefore never fires. It gives no result (the work's
 * is in the store, or nowhere); the fixture's charge carries on with its own receipt. Named
 * `TimeoutAsRan<Store>`; it wraps the store with its hold points, so the hold it gives up on is the
 * held store's.
 */
export function timeoutAsRan<TStore extends Class>(store: TStore): TStore {
  const Concrete = concreteOf(store);
  const original: unknown = Reflect.get(store.prototype, "runInTransaction");
  if (typeof original !== "function")
    throw new TypeError(`${store.name} has no runInTransaction: it is not a fenced-effect store`);
  const base = original as RunInTransaction;
  const giving = class extends Concrete {
    async runInTransaction(key: EffectKey, work: unknown): Promise<unknown> {
      const given = new AbortController();
      const answered = base.call(this, key, work);
      const gaveUp = systemClock.sleep(GIVES_UP_AFTER, given.signal).then(() => ({
        status: FencedEffectStatus.Ran,
        result: undefined,
        token: key.token,
      }));
      try {
        return await Promise.race([answered, gaveUp]);
      } finally {
        given.abort();
      }
    }
  };
  Object.defineProperty(giving, "name", { value: `TimeoutAsRan${store.name}` });
  const deps: readonly Token[] = depsOf(store);
  Injectable({ deps: deps as [] })(giving);
  const typed: unknown = giving;
  return typed as TStore;
}

type Release = (this: object, lease: unknown) => Promise<unknown>;

/**
 * `store` (a lease store class) whose `retire` is a plain `release` (#520, #971): a finished
 * child's lease is free for the next `acquire`; named `Releasing<Store>`.
 */
export function retireReleases<TStore extends Class>(store: TStore): TStore {
  const Concrete = concreteOf(store);
  const original: unknown = Reflect.get(store.prototype, "release");
  if (typeof original !== "function")
    throw new TypeError(`${store.name} has no release: it is not a lease store`);
  const base = original as Release;
  const releasing = class extends Concrete {
    retire(lease: unknown): Promise<unknown> {
      return base.call(this, lease);
    }
  };
  Object.defineProperty(releasing, "name", { value: `Releasing${store.name}` });
  const deps: readonly Token[] = depsOf(store);
  Injectable({ deps: deps as [] })(releasing);
  const typed: unknown = releasing;
  return typed as TStore;
}

/** How each sabotage breaks a store class, and the contract's methods whose stores it breaks. */
const BREAKS: Readonly<
  Record<
    FaultStoreSabotage,
    {
      readonly of: Readonly<Record<string, StoreMethod>>;
      readonly break: (store: Class) => Class;
      /** Wraps the store with its hold points, not the store the holds wrap. */
      readonly isOutside?: true;
    }
  >
> = {
  [FaultStoreSabotage.StaleThenKilled]: { of: FENCED_EFFECT_METHODS, break: staleThenKilled },
  [FaultStoreSabotage.RetireReleases]: { of: LEASE_METHODS, break: retireReleases },
  [FaultStoreSabotage.TimeoutAsRan]: {
    of: FENCED_EFFECT_METHODS,
    break: timeoutAsRan,
    isOutside: true,
  },
};

/** Whether `sabotage` breaks the store with its hold points on (it answers before a hold does). */
export const isOutsideHolds = (sabotage: FaultStoreSabotage): boolean =>
  BREAKS[sabotage].isOutside === true;

/** Whether `sabotage` breaks the stores of the contract with `methods`. */
export const breaksContract = (
  sabotage: FaultStoreSabotage,
  methods: Readonly<Record<string, StoreMethod>>,
): boolean => BREAKS[sabotage].of === methods;

/** The store class `sabotage` makes of `store`. */
export const sabotagedStoreOf = (store: Class, sabotage: FaultStoreSabotage): Class =>
  BREAKS[sabotage].break(store);
