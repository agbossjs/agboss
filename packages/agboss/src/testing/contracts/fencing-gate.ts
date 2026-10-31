import type { TestContext } from "vitest";
import { LeaseCheck } from "../../infrastructure/execution-lease.repository.js";
import { StoreConformanceError } from "./store-conformance-check.js";
import type { ContractCaseBody, ContractInstances } from "./seam.js";

/**
 * The opt-out in the contract suites (#543): a fencing store that declares
 * `static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection` says it checks the lease outside its
 * write's transaction, so it is not conformant for fencing — whatever its cases would show. Its
 * fencing cases (a stale or expired lease refused, the zombie and lease races) never count as passed:
 * refused unless the call also says `acceptWithoutDoubleChargeProtection: true`, then skipped with
 * `OPTED_OUT_REASON`. Every other case runs as for any store.
 */

/** Why a fencing case of an opted-out store is skipped. */
export const OPTED_OUT_REASON = "store opted out of the lease check: no double-charge protection";

/** Whether a fencing suite accepts an opt-out, and whether it shows it itself. */
export interface OptOut {
  /** The call said `acceptWithoutDoubleChargeProtection: true`. */
  readonly isAccepted: boolean;
  /**
   * The suite registers `OPT_OUT_SHOWN_CASE` (#543 acceptance): a contract run alone does; under
   * `storeConformance` the set's suite shows it (`gives NO double-charge protection for …`).
   */
  readonly isShown: boolean;
}

/** How a fencing contract's cases find the store under test, and whether its opt-out is accepted. */
export interface FencingGate<TStore> extends OptOut {
  /** The store whose `leaseCheck` decides: the fenced-effect or the outbound-call store. */
  readonly storeOf: (stores: TStore) => object;
}

/** The opt-out of a call's options: shown by the suite itself when `isShownHere` and accepted. */
export const optOutOf = (options: FencingContractOptions, isShownHere: boolean): OptOut => {
  const isAccepted = options.acceptWithoutDoubleChargeProtection === true;
  return { isAccepted, isShown: isShownHere && isAccepted };
};

/**
 * The case a fencing contract run alone with the flag adds (#543 acceptance): it passes for an
 * opted-out store — so a report that hides skipped cases still says what was not proven — and fails
 * for a store that does not opt out (the flag is then not needed: drop it).
 */
export const OPT_OUT_SHOWN_CASE =
  "gives NO double-charge protection: its store opted out of the lease check (acceptWithoutDoubleChargeProtection)";

/** The body of `OPT_OUT_SHOWN_CASE`: the store under test must declare the opt-out. */
export const shownOptOutBody =
  <TStore>(gate: FencingGate<TStore>): ContractCaseBody<TStore> =>
  (instances: ContractInstances<TStore>): Promise<void> => {
    const store = gate.storeOf(instances.first);
    if (!isOptedOutStore(store))
      throw new StoreConformanceError([
        `[store-conformance.opt-out-not-declared] acceptWithoutDoubleChargeProtection is set, but ${(store.constructor as { readonly name: string }).name} does not declare LeaseCheck.WithoutDoubleChargeProtection: its fencing cases ran — drop the flag`,
      ]);
    return Promise.resolve();
  };

/** Options of a fencing contract suite (#543). */
export interface FencingContractOptions {
  /**
   * The store opts out of the atomic lease check (`LeaseCheck.WithoutDoubleChargeProtection`) and
   * the caller knows it: its fencing cases are skipped, never passed. Without it an opted-out store
   * fails every fencing case with `StoreConformanceError`.
   */
  readonly acceptWithoutDoubleChargeProtection?: boolean;
}

/** Whether `store`'s class declares the opt-out. */
export const isOptedOutStore = (store: object): boolean =>
  Reflect.get(store.constructor, "leaseCheck") === LeaseCheck.WithoutDoubleChargeProtection;

/** The refusal of an opted-out store the call did not accept, naming it. */
export const optedOutRefusal = (store: object): StoreConformanceError =>
  new StoreConformanceError([
    `[store-conformance.opted-out-store] ${(store.constructor as { readonly name: string }).name} declares LeaseCheck.WithoutDoubleChargeProtection: it gives no double-charge protection, so its fencing cases cannot pass — pass acceptWithoutDoubleChargeProtection: true to run the rest, its fencing cases skipped, and never let it back payments`,
  ]);

/**
 * The body of a fencing case behind the gate: an opted-out store is refused (not accepted) or the
 * case skipped (accepted) before the case's own body runs; any other store runs it.
 */
export const gatedBody =
  <TStore>(
    gate: FencingGate<TStore>,
    body: ContractCaseBody<TStore>,
    context: TestContext,
  ): ContractCaseBody<TStore> =>
  async (instances: ContractInstances<TStore>): Promise<void> => {
    const store = gate.storeOf(instances.first);
    if (isOptedOutStore(store)) {
      if (!gate.isAccepted) throw optedOutRefusal(store);
      context.skip(OPTED_OUT_REASON);
    }
    await body(instances);
  };
