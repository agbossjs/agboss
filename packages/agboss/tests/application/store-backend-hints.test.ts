/**
 * #539 — the store-backend errors of #526 tell an operator exactly what to fix:
 *
 * - AC1: a mismatch's hint names the fencing store's backend and, when the core has one, the lease
 *   store on it (in-memory, SQLite), else a lease store declaring it (`postgres:billing`); and, the
 *   other way, the core's fencing store on the leases' backend;
 * - AC2: two listed stores of one fencing contract — or two lease stores — are
 *   `[di.ambiguous-implementation]` at assembly, naming both with their backends;
 * - AC3: every violation of a layout is reported at once, never the first only.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
} from "../../src/index.js";
import {
  BillingCalls,
  BillingEffects,
  BillingLeases,
  PostgresCalls,
  PostgresEffects,
  PostgresLeases,
  RedisLeases,
  storesApplication,
  UncheckedEffects,
  UndeclaredEffects,
  UndeclaredLeases,
} from "./fixtures/store-backends.fixture.js";

/** `[code] message` of every violation assembling `providers` reports; `[]` when it assembles. */
async function violationsOf(providers: readonly Provider[]): Promise<readonly string[]> {
  try {
    await applicationOf(storesApplication(providers));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

const codesOf = async (providers: readonly Provider[]): Promise<readonly string[]> =>
  (await violationsOf(providers)).map((line) => /^\[([^\]]+)\]/u.exec(line)?.[1] ?? line);

/** The hint of the one mismatch assembling `providers` reports: the text after its dash. */
async function hintOf(providers: readonly Provider[]): Promise<string> {
  const [mismatch, ...rest] = await violationsOf(providers);
  expect(rest).toEqual([]);
  expect(mismatch).toMatch(/^\[application\.store-backend-mismatch\] /u);
  return mismatch?.split("would not stop its write — ")[1] ?? "";
}

describe("#539 AC1: the hint names a lease store on the fencing store's backend", () => {
  it.each([
    [
      "a PostgreSQL fenced-effect store beside the in-memory default leases",
      [PostgresEffects],
      'list it with a lease store declaring backend "postgres", or list a fenced-effect store declaring backend "in-memory" (InMemoryFencedEffectRepository) in its place',
    ],
    [
      "the SQLite fenced-effect store beside PostgreSQL leases",
      [SqliteFencedEffectRepository, PostgresLeases],
      'list it with a lease store declaring backend "sqlite" (SqliteExecutionLeaseRepository), or list a fenced-effect store declaring backend "postgres" in its place',
    ],
    [
      "the in-memory outbound-call store beside SQLite leases",
      [InMemoryOutboundCallRepository, SqliteExecutionLeaseRepository],
      'list it with a lease store declaring backend "in-memory" (InMemoryExecutionLeaseRepository), or list an outbound-call store declaring backend "sqlite" (SqliteOutboundCallRepository) in its place',
    ],
    [
      'an outbound-call store on "postgres:billing" beside SQLite leases',
      [BillingCalls, SqliteExecutionLeaseRepository],
      'list it with a lease store declaring backend "postgres:billing", or list an outbound-call store declaring backend "sqlite" (SqliteOutboundCallRepository) in its place',
    ],
    [
      'a fenced-effect store on "postgres:billing" beside PostgreSQL leases on another database',
      [BillingEffects, PostgresLeases],
      'list it with a lease store declaring backend "postgres:billing", or list a fenced-effect store declaring backend "postgres" in its place',
    ],
  ] as const)("%s", async (_layout, providers, hint) => {
    expect(await hintOf(providers)).toBe(hint);
  });

  it("never suggests a SQLite store for a backend that is not SQLite", async () => {
    for (const providers of [[PostgresEffects], [PostgresCalls, RedisLeases], [BillingEffects]])
      expect(await hintOf(providers)).not.toContain("Sqlite");
  });
});

describe("#539 AC2: two listed stores of one fencing contract", () => {
  it("two fenced-effect stores beside PostgreSQL leases: named both, each one also checked", async () => {
    expect(
      await violationsOf([
        SqliteFencedEffectRepository,
        InMemoryFencedEffectRepository,
        PostgresLeases,
      ]),
    ).toEqual([
      '[di.ambiguous-implementation] 2 listed classes are fenced-effect stores (FencedEffectRepository): SqliteFencedEffectRepository (backend "sqlite"), InMemoryFencedEffectRepository (backend "in-memory") — list one',
      expect.stringContaining("[application.store-backend-mismatch] SqliteFencedEffectRepository"),
      expect.stringContaining(
        "[application.store-backend-mismatch] InMemoryFencedEffectRepository",
      ),
    ]);
  });

  it("two stores of one backend, both matching the leases: still two, the ambiguity alone", async () => {
    expect(await codesOf([PostgresEffects, BillingEffects, BillingLeases])).toEqual([
      "di.ambiguous-implementation",
      "application.store-backend-mismatch",
    ]);
    expect(await codesOf([SqliteOutboundCallRepository, PostgresCalls, PostgresLeases])).toEqual([
      "di.ambiguous-implementation",
      "application.store-backend-mismatch",
    ]);
  });

  it("an opted-out second store is a second store too", async () => {
    expect(await violationsOf([PostgresEffects, UncheckedEffects, PostgresLeases])).toEqual([
      '[di.ambiguous-implementation] 2 listed classes are fenced-effect stores (FencedEffectRepository): PostgresEffects (backend "postgres"), UncheckedEffects (no backend) — list one',
    ]);
  });

  it("two lease stores: named both; no fencing store is compared with either", async () => {
    expect(
      await violationsOf([
        PostgresLeases,
        InMemoryExecutionLeaseRepository,
        SqliteFencedEffectRepository,
      ]),
    ).toEqual([
      '[di.ambiguous-implementation] 2 listed classes are lease stores (ExecutionLeaseRepository): PostgresLeases (backend "postgres"), InMemoryExecutionLeaseRepository (backend "in-memory") — list one',
    ]);
  });

  it("one store listed once assembles; a class listed twice is one store", async () => {
    expect(await codesOf([PostgresEffects, PostgresLeases])).toEqual([]);
    expect(await codesOf([PostgresEffects, PostgresEffects, PostgresLeases])).toEqual([]);
  });
});

describe("#539 AC3: every violation of a layout at once", () => {
  it.each([
    [
      "one fencing store of another backend",
      [PostgresEffects, RedisLeases],
      ["application.store-backend-mismatch"],
    ],
    [
      "both fencing stores of another backend",
      [PostgresEffects, PostgresCalls, SqliteExecutionLeaseRepository],
      ["application.store-backend-mismatch", "application.store-backend-mismatch"],
    ],
    [
      "an undeclared fencing store and an undeclared lease store",
      [UndeclaredEffects, UndeclaredLeases],
      ["application.store-backend-undeclared", "application.store-backend-undeclared"],
    ],
    [
      "an undeclared lease store under both fencing stores",
      [PostgresEffects, PostgresCalls, UndeclaredLeases],
      ["application.store-backend-undeclared", "application.store-backend-undeclared"],
    ],
    [
      "two fenced-effect stores of other backends and an outbound-call store of another",
      [SqliteFencedEffectRepository, InMemoryFencedEffectRepository, PostgresCalls, BillingLeases],
      [
        "di.ambiguous-implementation",
        "application.store-backend-mismatch",
        "application.store-backend-mismatch",
        "application.store-backend-mismatch",
      ],
    ],
    [
      "two stores of each fencing contract",
      [PostgresEffects, BillingEffects, PostgresCalls, BillingCalls, PostgresLeases],
      [
        "di.ambiguous-implementation",
        "application.store-backend-mismatch",
        "di.ambiguous-implementation",
        "application.store-backend-mismatch",
      ],
    ],
    [
      "two lease stores and two fencing stores",
      [PostgresLeases, BillingLeases, PostgresEffects, BillingEffects],
      ["di.ambiguous-implementation", "di.ambiguous-implementation"],
    ],
    ["all on one backend", [PostgresLeases, PostgresEffects, PostgresCalls], []],
  ] as const)("%s", async (_layout, providers, codes) => {
    expect(await codesOf(providers)).toEqual(codes);
  });
});
