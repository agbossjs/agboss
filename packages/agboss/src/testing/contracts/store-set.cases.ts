import { describe, expect, it } from "vitest";
import { backendOf } from "../../application/implementations.js";
import type { Class } from "../../components/injection.js";
import {
  LeaseCheck,
  type ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectStores } from "./fenced-effect-data.js";
import type { OutboundCallStores } from "./outbound-call-data.js";
import { withTarget, type ContractTarget } from "./seam.js";

/**
 * The cases of `store set (<name>)` (#526): what assembly will check of the set's classes, checked
 * here first — each fencing store declares `static backend`, and a fenced-effect or outbound-call
 * store is on the backend of the lease store it checks (or declares the opt-out
 * `LeaseCheck.WithoutDoubleChargeProtection`), so the set assembles beside its own leases.
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

/** Registers the store set's cases for the fencing targets it has. */
export function registerStoreSet(name: string, targets: FencingTargets): void {
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
        withTarget(fencedEffect, ({ first }) => {
          expectOneBackend(first.effects, first.leases);
          return Promise.resolve();
        }),
      );
    if (outboundCall !== undefined)
      it(
        "the outbound-call store is on the backend of the lease store it checks, or opts out",
        withTarget(outboundCall, ({ first }) => {
          expectOneBackend(first.calls, first.leases);
          return Promise.resolve();
        }),
      );
  });
}
