import type { ExecutionLeaseRepository } from "../../../infrastructure/execution-lease.repository.js";
import { seconds } from "../../../units/index.js";
import { ClockSkew } from "../../clock-skew.js";
import type { FencedEffectStores } from "../fenced-effect-data.js";
import type { OutboundCallStores } from "../outbound-call-data.js";
import type { ContractTarget } from "../seam.js";
import {
  EXPLORED_LEASE,
  ExplorerWorldKind,
  type ExplorerStores,
  type ExplorerWorld,
} from "./types.js";

/**
 * The worlds the explorer runs (#533 item 1) and the store sets they run on: every lease operation
 * with `leaseStateOf` (on the outbound-call target: its leases and the check; without one, on the
 * lease store alone, #694), the step's fenced
 * effect, and the outbound call — handed over on one tree, and under one business key from two.
 * Each runs with the second instance's own clock on time and off by ± lease/2, ± lease and ± 10 ×
 * lease, the store on the run's time: a store that decides by its caller's clock gives two holders.
 */

/** How far the second instance's clock is off, in each run of a world. */
export const EXPLORED_SKEWS: readonly ClockSkew[] = [
  ClockSkew.none,
  ClockSkew.ahead(seconds(15)),
  ClockSkew.behind(seconds(15)),
  ClockSkew.ahead(EXPLORED_LEASE),
  ClockSkew.behind(EXPLORED_LEASE),
  ClockSkew.ahead(seconds(300)),
  ClockSkew.behind(seconds(300)),
];

/** The skews of the worlds beyond the lease's own: on time, a lease ahead, a lease behind. */
export const CALL_SKEWS: readonly ClockSkew[] = [
  ClockSkew.none,
  ClockSkew.ahead(EXPLORED_LEASE),
  ClockSkew.behind(EXPLORED_LEASE),
];

/** A skew as a title names it. */
export const skewText = (skew: ClockSkew): string =>
  skew.offset === 0 ? "on time" : `${skew.offset > 0 ? "+" : ""}${String(skew.offset / 1000)} s`;

/** A world of `instances` on `kind`: instance 2 off by `skew`, instance 3 the other way. */
export function worldOf(
  kind: ExplorerWorldKind,
  instances: number,
  skew: ClockSkew,
  isBusinessKey = false,
): ExplorerWorld {
  const opposite =
    skew.offset >= 0
      ? ClockSkew.behind(seconds(skew.offset / 1000))
      : ClockSkew.ahead(seconds(-skew.offset / 1000));
  return {
    kind,
    instances,
    treeOf: (instance) => (isBusinessKey && instance % 2 === 0 ? "tree-2" : "tree-1"),
    skewOf: (instance) => (instance === 1 ? ClockSkew.none : instance === 2 ? skew : opposite),
  };
}

/** A target of another store kind, as the explorer's stores. */
function mapped<TStore>(
  target: ContractTarget<TStore>,
  storesOf: (store: TStore) => ExplorerStores,
): ContractTarget<ExplorerStores> {
  const built = new Map<ExplorerStores, TStore>();
  return {
    name: target.name,
    ...(target.reset === undefined ? {} : { reset: () => target.reset?.() }),
    instance: async (seam) => {
      const store = await target.instance(seam);
      const stores = storesOf(store);
      built.set(stores, store);
      return stores;
    },
    close: async (stores) => {
      const store = built.get(stores);
      built.delete(stores);
      if (store !== undefined) await target.close?.(store);
    },
  };
}

/** The lease store alone as the explorer's stores (#694: the lease world of a set without calls). */
export const leaseTarget = (
  target: ContractTarget<ExecutionLeaseRepository>,
): ContractTarget<ExplorerStores> => mapped(target, (leases) => ({ leases }));

/** The outbound-call target as the explorer's stores (the lease world's and the call world's). */
export const callTarget = (
  target: ContractTarget<OutboundCallStores>,
): ContractTarget<ExplorerStores> => mapped(target, ({ calls, leases }) => ({ calls, leases }));

/** The fenced-effect target as the explorer's stores. */
export const effectTarget = (
  target: ContractTarget<FencedEffectStores<unknown>>,
): ContractTarget<ExplorerStores> =>
  mapped(target, ({ effects, leases, rows }) => ({ effects, leases, rows }));
