import { describe, expect, it, type TestContext } from "vitest";
import { backendOf } from "../../application/implementations.js";
import type { Class } from "../../components/injection.js";
import {
  LeaseCheck,
  type ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectStores } from "./fenced-effect-data.js";
import { isOptedOutStore, OPTED_OUT_REASON, optedOutRefusal } from "./fencing-gate.js";
import type { OutboundCallStores } from "./outbound-call-data.js";
import { withTarget, type ContractTarget } from "./seam.js";

/**
 * The cases of `store set (<name>)` (#526): what assembly will check of the set's classes, checked
 * here first — each fencing store declares `static backend`, and a fenced-effect or outbound-call
 * store is on the backend of the lease store it checks (or declares the opt-out
 * `LeaseCheck.WithoutDoubleChargeProtection`), so the set assembles beside its own leases. The lease
 * store it checks is the set's `executionLease` (#542): the fencing store is compared with it, and
 * the lease store its own contract ran on is of its backend — the races are proven on the leases
 * the application will list. A store that opts out of the lease check is refused there unless the
 * set says `acceptWithoutDoubleChargeProtection` (#543), and then its case is skipped and the set
 * shows `gives NO double-charge protection for …` among its cases.
 */

/** The fencing targets of a set, as `storeConformance` builds them. */
export interface FencingTargets {
  readonly executionLease?: ContractTarget<ExecutionLeaseRepository> | undefined;
  readonly fencedEffect?: ContractTarget<FencedEffectStores<unknown>> | undefined;
  readonly outboundCall?: ContractTarget<OutboundCallStores> | undefined;
}

const classOf = (store: object): Class => store.constructor as Class;

/** `store`'s class declares a backend: `static backend`, a non-empty text. */
function expectDeclared(store: object, what: string): void {
  const backend = backendOf(classOf(store));
  expect(backend, `${classOf(store).name}, ${what}, declares no static backend`).toBeTypeOf(
    "string",
  );
}

/** `store` is on the backend of `leases`, unless it opts out of the atomic lease check. */
function expectOneBackend(store: object, leases: object): void {
  if (Reflect.get(classOf(store), "leaseCheck") === LeaseCheck.WithoutDoubleChargeProtection)
    return;
  expectDeclared(store, "a fencing store");
  expectDeclared(leases, "the lease store it checks");
  expect(
    backendOf(classOf(store)),
    `${classOf(store).name} checks the leases of ${classOf(leases).name} in its own transaction: one backend`,
  ).toBe(backendOf(classOf(leases)));
}

/** The class of the store `target` builds (one instance, built and closed as a case does). */
async function storeClassOf<TStore extends object>(target: ContractTarget<TStore>): Promise<Class> {
  let found: Class | undefined;
  await withTarget(target, ({ first }) => {
    found = classOf(first);
    return Promise.resolve();
  })();
  if (found === undefined) throw new Error("the lease target built no store");
  return found;
}

/**
 * `store` and the lease store its contract ran on are on the backend of the set's lease store
 * (#542): the store unless it opts out, its own leases always.
 */
function expectSetBackend(store: object, leases: object, setLeases: Class): void {
  const theirs = backendOf(setLeases);
  const isOptedOut =
    Reflect.get(classOf(store), "leaseCheck") === LeaseCheck.WithoutDoubleChargeProtection;
  if (!isOptedOut)
    expect(
      backendOf(classOf(store)),
      `${classOf(store).name} checks the leases of the set's lease store ${setLeases.name} (backend "${String(theirs)}") in its own transaction: one backend`,
    ).toBe(theirs);
  expect(
    backendOf(classOf(leases)),
    `${classOf(store).name}'s contract ran on the leases of ${classOf(leases).name}, but the set's lease store is ${setLeases.name} (backend "${String(theirs)}"): its races are proven on another backend`,
  ).toBe(theirs);
}

/** How the set's cases treat a store that opts out of the lease check (#543). */
interface OptOut {
  readonly isAccepted: boolean;
}

/** The case of one fencing store: one backend with the lease store of its target and of the set. */
const fencingCase =
  <TStores>(
    target: ContractTarget<TStores>,
    pair: (stores: TStores) => readonly [store: object, leases: object],
    setLeases: ContractTarget<ExecutionLeaseRepository> | undefined,
    optOut: OptOut,
  ) =>
  async (context: TestContext): Promise<void> => {
    const setClass = setLeases === undefined ? undefined : await storeClassOf(setLeases);
    await withTarget(target, ({ first }) => {
      const [store, leases] = pair(first);
      if (isOptedOutStore(store)) {
        if (!optOut.isAccepted) throw optedOutRefusal(store);
        context.skip(OPTED_OUT_REASON);
      }
      expectOneBackend(store, leases);
      if (setClass !== undefined) expectSetBackend(store, leases, setClass);
      return Promise.resolve();
    })();
  };

/** Whether the store `target` builds (through `pick`) opts out of the lease check. */
async function isOptedOutTarget<TStores>(
  target: ContractTarget<TStores>,
  pick: (stores: TStores) => object,
): Promise<boolean> {
  let isOptedOut = false;
  await withTarget(target, ({ first }) => {
    isOptedOut = isOptedOutStore(pick(first));
    return Promise.resolve();
  })();
  return isOptedOut;
}

/**
 * The cases an accepted opt-out adds (#543): `gives NO double-charge protection for …` for each
 * fencing store that opts out — passing, so every report shows it — and a case that fails when the
 * set accepts an opt-out none of its stores declares.
 */
function registerOptOutCases({ fencedEffect, outboundCall }: FencingTargets): void {
  const effectsOptOut = (): Promise<boolean> =>
    fencedEffect === undefined
      ? Promise.resolve(false)
      : isOptedOutTarget(fencedEffect, (stores) => stores.effects);
  const callsOptOut = (): Promise<boolean> =>
    outboundCall === undefined
      ? Promise.resolve(false)
      : isOptedOutTarget(outboundCall, (stores) => stores.calls);
  const shown = (label: string, isOptedOut: () => Promise<boolean>): void => {
    it(`gives NO double-charge protection for ${label}`, async (context) => {
      if (!(await isOptedOut()))
        context.skip(`its ${label} store checks the lease atomically: its fencing cases ran`);
      expect(true).toBe(true);
    });
  };
  if (fencedEffect !== undefined) shown("fenced effects", effectsOptOut);
  if (outboundCall !== undefined) shown("outbound calls", callsOptOut);
  it("accepts an opt-out only where a store declares one (acceptWithoutDoubleChargeProtection)", async () => {
    const isDeclared = (await effectsOptOut()) || (await callsOptOut());
    expect(
      isDeclared,
      "acceptWithoutDoubleChargeProtection is set, but no fencing store declares LeaseCheck.WithoutDoubleChargeProtection: drop the flag",
    ).toBe(true);
  });
}

/** Registers the store set's cases for the fencing targets it has. */
export function registerStoreSet(
  name: string,
  targets: FencingTargets,
  optOut: OptOut = { isAccepted: false },
): void {
  describe(`store set (${name})`, () => {
    const { executionLease, fencedEffect, outboundCall } = targets;
    if (executionLease !== undefined)
      it(
        "the lease store declares its backend (static backend)",
        withTarget(executionLease, ({ first }) => {
          expectDeclared(first, "the lease store");
          return Promise.resolve();
        }),
      );
    if (fencedEffect !== undefined)
      it(
        "the fenced-effect store is on the backend of the lease store it checks, or opts out",
        fencingCase(
          fencedEffect,
          (stores) => [stores.effects, stores.leases],
          executionLease,
          optOut,
        ),
      );
    if (outboundCall !== undefined)
      it(
        "the outbound-call store is on the backend of the lease store it checks, or opts out",
        fencingCase(
          outboundCall,
          (stores) => [stores.calls, stores.leases],
          executionLease,
          optOut,
        ),
      );
    if (optOut.isAccepted) registerOptOutCases(targets);
  });
}
