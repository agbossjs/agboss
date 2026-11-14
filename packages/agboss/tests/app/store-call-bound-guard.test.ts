/**
 * #928 AC1 guard — the bound covers every call of every bounded contract: a store that never
 * answers any method of its contract is given up on, and nothing about the store but its calls
 * changes (`instanceof`, `#private` fields, `static store`, the in-memory lease check, a joined
 * `runOnce`), and the proxy is never stacked.
 */
import { describe, expect, it } from "vitest";
import { FencedEffectRepository, FencedEffectStatus } from "../../src/index.js";
import { boundedStoreOf, targetOf } from "../../src/app/store-call-bound.js";
import { LONG_CALL_BOUND, RENEW_BOUND, STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import { StoreBounds } from "../../src/app/store-bounds.js";
import type { Class } from "../../src/components/injection.js";
import {
  BOUNDED_CONTRACTS,
  INFRASTRUCTURE_DEFAULTS,
  boundedContractOf,
} from "../../src/infrastructure/contracts.js";
import { A2AFileRepository } from "../../src/infrastructure/a2a-file.repository.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { StoreCallTimeoutError } from "../../src/infrastructure/store-call-timeout.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  book,
  DoubleChargeWorkflowStart,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import { StoreBoundApplication } from "./fixtures/store-bound.application.js";

const test = testWith(StoreBoundApplication);

/** The names of the functions on `cls`'s prototype chain, below `Object`. */
function methodsOf(cls: Class): string[] {
  const names = new Set<string>();
  for (let proto: object | null = cls.prototype; proto !== null && proto !== Object.prototype;) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const value = Object.getOwnPropertyDescriptor(proto, name)?.value;
      if (name !== "constructor" && typeof value === "function") names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

/** Every bounded contract with the methods its built-in default has. */
const CONTRACTS: readonly (readonly [Class, readonly string[]])[] = [...BOUNDED_CONTRACTS].map(
  (contract) => [contract, methodsOf(INFRASTRUCTURE_DEFAULTS.get(contract) ?? contract)],
);

const HOOKS: ReadonlySet<string> = new Set(["onInit", "onStart", "onStop", "onDestroy"]);

/** A store whose every method of `names` never answers. */
const silent = (names: readonly string[]): object =>
  Object.fromEntries(names.map((name) => [name, () => new Promise<never>(() => undefined)]));

describe("#928 AC1 guard: every method of every bounded contract is bounded", () => {
  it("the bounded contracts are every infrastructure contract but the clock, ids and logger", () => {
    expect(CONTRACTS.length).toBeGreaterThanOrEqual(15);
    expect([...BOUNDED_CONTRACTS].map((contract) => contract.name)).not.toContain("Clock");
  });

  for (const [contract, names] of CONTRACTS) {
    it(`${contract.name}: a silent store is given up on at the bound of each method`, async () => {
      const clock = new VirtualClock();
      const bounded = boundedStoreOf(contract, silent(names), new StoreBounds(clock));
      for (const name of names.filter((one) => !HOOKS.has(one))) {
        const call: unknown = Reflect.get(bounded, name);
        if (typeof call !== "function") throw new TypeError(`${name} is not a function`);
        const answer: unknown = Reflect.apply(call, bounded, []);
        const settled = Promise.race([
          Promise.resolve(answer).then(
            () => "answered",
            (error: unknown) => error,
          ),
          Promise.resolve("pending"),
        ]);
        expect(await settled).toBe("pending");
        const isLong = /^delete\w*Before$/u.test(name) || contract === A2AFileRepository;
        const bound = isLong
          ? LONG_CALL_BOUND
          : name === "renew" && contract === ExecutionLeaseRepository
            ? RENEW_BOUND
            : STORE_CALL_BOUND;
        const rejects = Promise.resolve(answer).then(
          () => undefined,
          (error: unknown) => error,
        );
        await clock.advance(bound);
        const error = await rejects;
        expect(error, `${contract.name}.${name}`).toBeInstanceOf(StoreCallTimeoutError);
        expect(error).toMatchObject({
          operation: name,
          timeout: bound,
        });
      }
    });
  }

  it("MAINTENANCE_METHODS is exactly the delete…Before methods, each of them bounded by 5 minutes", () => {
    const found = new Set(
      CONTRACTS.flatMap(([, names]) => names).filter((name) => /^delete\w*Before$/u.test(name)),
    );
    expect([...found].sort()).toEqual([
      "deleteByCreatedAtBefore",
      "deleteByEndedAtBefore",
      "deleteByMadeAtBefore",
      "deleteByOccurredAtBefore",
      "deleteByResolvedAtBefore",
      "deleteByStoredAtBefore",
      "deleteTerminalByStatusAtBefore",
    ]);
  });
});

describe("#928 AC1 guard: the store behind the proxy is the same store", () => {
  test("instanceof, #private, static store, inMemoryLeaseMismatch and a Joined runOnce work through the proxy", async ({
    app,
  }) => {
    resetFencedEffect();
    await app.ready();
    const effects = app.resolve(FencedEffectRepository);
    expect(effects).toBeInstanceOf(InMemoryFencedEffectRepository);
    expect(targetOf(effects)).not.toBe(effects);
    expect(effects.constructor).toBe(targetOf(effects).constructor);
    expect(Reflect.get(effects.constructor, "store")).toEqual({ backend: "in-memory" });
    const leases = app.resolve(ExecutionLeaseRepository);
    expect(leases).toBeInstanceOf(ExecutionLeaseRepository);

    const result = await execute(app, DoubleChargeWorkflowStart, { text: "order-8" });

    expect(result.output).toEqual({ chargeId: "order-8" });
    expect(book.runs.map((run) => run.status)).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Joined,
    ]);
  });

  test("never wrapped twice; get(Contract) and get(ConcreteClass) give one proxy", async ({
    app,
  }) => {
    await app.ready();
    const bounds = new StoreBounds(new VirtualClock());
    const once = boundedStoreOf(FencedEffectRepository, silent(["runOnce"]), bounds);
    expect(boundedStoreOf(FencedEffectRepository, once, bounds)).toBe(once);
    expect(targetOf(targetOf(once))).toBe(targetOf(once));

    const byContract = app.resolve(FencedEffectRepository);
    expect(app.resolve(InMemoryFencedEffectRepository)).toBe(byContract);
    expect(byContract).toBeInstanceOf(InMemoryFencedEffectRepository);
    expect(boundedContractOf(InMemoryFencedEffectRepository)).toBe(FencedEffectRepository);
  });
});
