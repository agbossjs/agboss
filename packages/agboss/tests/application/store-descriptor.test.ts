/**
 * #825 — a listed store's `static store` that is no `{ backend, leaseCheck? }` is refused at
 * assembly (`[application.store-descriptor-invalid]`), never read as undeclared or as atomic.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import {
  Clock,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  InMemoryFencedEffectRepository,
  Injectable,
  LeaseCheck,
  type Provider,
  type StoreDescriptor,
} from "../../src/index.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import {
  optsOutOfLeaseCheck,
  storeDescriptorOf,
} from "../../src/infrastructure/store-descriptor.js";
import { storesApplication } from "./fixtures/store-backends.fixture.js";

const DEPS = [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] as const;

/** What a JavaScript store, or a cast, declares as its descriptor. */
const declared = (value: unknown): StoreDescriptor => value as StoreDescriptor;

@Injectable({ deps: DEPS })
class NumberBackendEffects extends InMemoryFencedEffectRepository {
  static override readonly store = declared({ backend: 5 });
}

@Injectable({ deps: DEPS })
class TypoLeaseCheckEffects extends InMemoryFencedEffectRepository {
  static override readonly store = declared({
    backend: "in-memory",
    leaseCheck: "without-double-charge",
  });
}

@Injectable({ deps: DEPS })
class ThrowingEffects extends InMemoryFencedEffectRepository {
  static override get store(): StoreDescriptor {
    throw new Error("not readable");
  }
}

async function codesOf(providers: readonly Provider[]): Promise<readonly string[]> {
  try {
    await applicationOf(storesApplication(providers));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

describe("#825: a static store that is no StoreDescriptor", () => {
  it.each([
    [NumberBackendEffects, "names a backend that is no text (number)"],
    [TypoLeaseCheckEffects, "names a leaseCheck that is no LeaseCheck"],
    [ThrowingEffects, "throws when it is read"],
  ])("%o is refused at assembly, naming what is wrong", async (store, problem) => {
    expect(await codesOf([store])).toContainEqual(
      `[application.store-descriptor-invalid] ${store.name}'s static store ${problem}: declare static store: StoreDescriptor = { backend: "postgres" } (leaseCheck: LeaseCheck.WithoutDoubleChargeProtection only to opt out)`,
    );
  });

  it("read on its own: what is no descriptor is undeclared — never an opt-out, never a throw", () => {
    expect(storeDescriptorOf(NumberBackendEffects)).toEqual({ backend: undefined });
    expect(storeDescriptorOf(TypoLeaseCheckEffects)).toEqual({ backend: "in-memory" });
    expect(storeDescriptorOf(ThrowingEffects)).toEqual({ backend: undefined });
    expect(optsOutOfLeaseCheck(TypoLeaseCheckEffects)).toBe(false);
    expect(LeaseCheck.WithoutDoubleChargeProtection).toBe("without-double-charge-protection");
  });
});
