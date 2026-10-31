/**
 * #526 AC1 — one transactional backend, checked at assembly: a listed fenced-effect or
 * outbound-call store and the application's lease store (listed, else the in-memory default)
 * declare one `static backend`, else `[application.store-backend-mismatch]` (two backends) or
 * `[application.store-backend-undeclared]` (none, or an empty one) names the classes. Every pairing
 * of nine lease stores with nine stores of each fencing contract; the explicit opt-out
 * `LeaseCheck.WithoutDoubleChargeProtection` (not checked, a warning instead); the built-in stores'
 * declarations; the stores no backend binds (the lease log, rate limits, the queue).
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class, Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  ExecutionLeaseRepository,
  FencedEffectRepository,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  LeaseCheck,
  OutboundCallRepository,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
} from "../../src/index.js";
import {
  BillingLeases,
  CALL_STORES,
  EFFECT_STORES,
  LEASES,
  PostgresEffects,
  PostgresLeases,
  RedisCalls,
  RedisLeases,
  storesApplication,
  UndeclaredCalls,
  UndeclaredEffects,
  UndeclaredLeases,
  type FencingChoice,
  type LeaseChoice,
} from "./fixtures/store-backends.fixture.js";

/** The rule violations assembling `providers` reports: `[]` when it assembles. */
async function violationsOf(providers: readonly Provider[]): Promise<readonly string[]> {
  try {
    await applicationOf(storesApplication(providers));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

const leaseName = (lease: LeaseChoice): string =>
  lease.listed?.name ?? "InMemoryExecutionLeaseRepository";

/** What the rule says of `store` beside `lease`: each violation's code and the classes it names. */
function expected(store: FencingChoice, lease: LeaseChoice): readonly (readonly string[])[] {
  if (store.isOptedOut) return [];
  const found: (readonly string[])[] = [];
  if (store.backend === undefined)
    found.push(["application.store-backend-undeclared", `${store.store.name} declares no backend`]);
  if (lease.backend === undefined)
    found.push(["application.store-backend-undeclared", `${leaseName(lease)} declares no backend`]);
  if (store.backend !== undefined && lease.backend !== undefined && store.backend !== lease.backend)
    found.push([
      "application.store-backend-mismatch",
      `${store.store.name} (backend "${store.backend}")`,
      `${leaseName(lease)} (backend "${lease.backend}")`,
    ]);
  return found;
}

const pairings = (stores: readonly FencingChoice[]) =>
  stores.flatMap((store) =>
    LEASES.map((lease) => ({ store, lease, title: `${store.store.name} with ${lease.name}` })),
  );

describe.each([
  ["fenced-effect", EFFECT_STORES],
  ["outbound-call", CALL_STORES],
] as const)("#526 AC1: every pairing of a listed %s store with a lease store", (_kind, stores) => {
  it.each(pairings(stores))("$title", async ({ store, lease }) => {
    const providers = [store.store, ...(lease.listed === undefined ? [] : [lease.listed])];

    const found = await violationsOf(providers);

    const wanted = expected(store, lease);
    expect(found).toHaveLength(wanted.length);
    wanted.forEach(([code, ...names], index) => {
      expect(found[index]).toContain(`[${String(code)}]`);
      for (const name of names) expect(found[index]).toContain(name);
    });
  });
});

describe("#526 AC1: the pairings of both fencing stores at once", () => {
  it.each(
    EFFECT_STORES.flatMap((effects) =>
      CALL_STORES.map((calls) => ({
        effects,
        calls,
        title: `${effects.store.name} + ${calls.store.name}`,
      })),
    ),
  )(
    "$title with SqliteExecutionLeaseRepository: each store checked on its own",
    async ({ effects, calls }) => {
      const sqlite = LEASES.find((lease) => lease.listed === SqliteExecutionLeaseRepository);
      if (sqlite === undefined) throw new Error("no SQLite lease choice");

      const found = await violationsOf([
        effects.store,
        calls.store,
        SqliteExecutionLeaseRepository,
      ]);

      expect(found).toHaveLength(expected(effects, sqlite).length + expected(calls, sqlite).length);
    },
  );
});

const MISMATCH_EFFECT =
  '[application.store-backend-mismatch] PostgresEffects (backend "postgres") checks its leases in its own transaction, but the application\'s leases are in RedisLeases (backend "redis"): a lease taken over meanwhile would not stop its write — list it with a lease store declaring backend "postgres", or list a fenced-effect store declaring backend "redis" in its place';
const UNDECLARED_STORE =
  '[application.store-backend-undeclared] UndeclaredCalls declares no backend: an outbound-call store checks its leases in its own transaction, so it and its lease store declare the database they are in (static backend = "postgres") and assembly checks it is one — or it opts out with static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection, losing that protection';
const UNDECLARED_LEASES =
  '[application.store-backend-undeclared] UndeclaredLeases declares no backend: PostgresEffects, a fenced-effect store, checks the application\'s leases in its own transaction, so the lease store declares the database it is in (static backend = "postgres")';

describe("#526 AC1: the messages", () => {
  it("a mismatch names both classes and both backends, and what to do", async () => {
    expect(await violationsOf([PostgresEffects, RedisLeases])).toEqual([MISMATCH_EFFECT]);
  });

  it("an undeclared store names itself, how to declare and how to opt out", async () => {
    expect(await violationsOf([UndeclaredCalls, PostgresLeases])).toEqual([UNDECLARED_STORE]);
  });

  it("an undeclared lease store is named with the store that reads it", async () => {
    expect(await violationsOf([PostgresEffects, UndeclaredLeases])).toEqual([UNDECLARED_LEASES]);
  });

  it("both undeclared: two violations, the store's then the lease store's", async () => {
    const found = await violationsOf([UndeclaredEffects, UndeclaredLeases]);

    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(
      /^\[application\.store-backend-undeclared\] UndeclaredEffects declares no backend/u,
    );
    expect(found[1]).toMatch(
      /^\[application\.store-backend-undeclared\] UndeclaredLeases declares no backend: UndeclaredEffects, a fenced-effect store/u,
    );
  });

  it("every violation at once, with the application's other rules: one GraphRuleError", async () => {
    const error = await applicationOf(
      storesApplication([PostgresEffects, RedisCalls, BillingLeases]),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GraphRuleError);
    const violations = (error as GraphRuleError).violations;
    expect(violations.map((found) => [found.code, found.nodes])).toEqual([
      ["application.store-backend-mismatch", ["stores-application"]],
      ["application.store-backend-mismatch", ["stores-application"]],
    ]);
    expect(violations[0]?.message).toContain('PostgresEffects (backend "postgres")');
    expect(violations[1]?.message).toContain('RedisCalls (backend "redis")');
    expect((error as Error).message).toContain('BillingLeases (backend "postgres:billing")');
  });

  it("the old code is gone: no [application.fenced-effect-lease-store] for any pairing", async () => {
    const found = await violationsOf([SqliteFencedEffectRepository]);

    expect(found.join("\n")).not.toContain("fenced-effect-lease-store");
    expect(found).toEqual([
      expect.stringContaining(
        '[application.store-backend-mismatch] SqliteFencedEffectRepository (backend "sqlite") checks its leases in its own transaction, but the application\'s leases are in InMemoryExecutionLeaseRepository (backend "in-memory")',
      ),
    ]);
  });
});

describe("#526 AC1: the built-in stores declare their backends", () => {
  it.each([
    [InMemoryExecutionLeaseRepository, "in-memory"],
    [InMemoryFencedEffectRepository, "in-memory"],
    [InMemoryOutboundCallRepository, "in-memory"],
    [SqliteExecutionLeaseRepository, "sqlite"],
    [SqliteFencedEffectRepository, "sqlite"],
    [SqliteOutboundCallRepository, "sqlite"],
  ] as const)("%o declares %s", (store: Class, backend) => {
    expect(Reflect.get(store, "backend")).toBe(backend);
  });

  it("the contracts declare none: a store of a project declares its own", () => {
    expect(ExecutionLeaseRepository.backend).toBeUndefined();
    expect(FencedEffectRepository.backend).toBeUndefined();
    expect(OutboundCallRepository.backend).toBeUndefined();
  });

  it("every fencing store checks atomically unless it says otherwise", () => {
    for (const store of [
      FencedEffectRepository,
      OutboundCallRepository,
      InMemoryFencedEffectRepository,
      InMemoryOutboundCallRepository,
      SqliteFencedEffectRepository,
      SqliteOutboundCallRepository,
    ])
      expect(store.leaseCheck).toBe(LeaseCheck.Atomic);
  });

  it("the opt-out's value names what it loses", () => {
    expect(Object.values(LeaseCheck)).toEqual(["atomic", "without-double-charge-protection"]);
  });

  it.each([
    [[], "nothing listed"],
    [
      [InMemoryFencedEffectRepository, InMemoryOutboundCallRepository],
      "the in-memory stores listed",
    ],
    [
      [SqliteFencedEffectRepository, SqliteOutboundCallRepository, SqliteExecutionLeaseRepository],
      "the SQLite stores together",
    ],
  ] as const)("%#: %s assembles", async (providers: readonly Provider[], _title: string) => {
    expect(await violationsOf(providers)).toEqual([]);
  });

  it("an unlisted fencing store beside listed leases of another backend is not an assembly error", async () => {
    expect(await violationsOf([SqliteExecutionLeaseRepository])).toEqual([]);
    expect(await violationsOf([RedisLeases])).toEqual([]);
  });
});
