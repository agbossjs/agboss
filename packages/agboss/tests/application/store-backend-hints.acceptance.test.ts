/**
 * #539 acceptance — the corners of the store-backend errors the handoff's tables leave open:
 * - a backend that is one of the core's kinds on another database (`sqlite:reports`) is offered no
 *   core store, either way;
 * - a backend named like a member every object has (`constructor`, `toString`) is still only a name
 *   in the hint;
 * - three stores of one contract, a subclass listed with its parent, and two opted-out stores are
 *   each one `[di.ambiguous-implementation]` naming every one of them;
 * - every violation of a mixed layout comes at once, in a stable order.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  ApplicationContext,
  Clock,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  InMemoryFencedEffectRepository,
  Injectable,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
} from "../../src/index.js";
import {
  PostgresEffects,
  PostgresLeases,
  storesApplication,
  UncheckedEffects,
  UncheckedRedisEffects,
} from "./fixtures/store-backends.fixture.js";

const LEASE_DEPS = { deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] } as const;
const EFFECT_DEPS = {
  deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
} as const;

@Injectable(EFFECT_DEPS)
class ReportsEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "sqlite:reports";
}

@Injectable(LEASE_DEPS)
class ReportsLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = "sqlite:reports";
}

@Injectable(EFFECT_DEPS)
class ConstructorEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "constructor";
}

@Injectable(LEASE_DEPS)
class ToStringLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = "toString";
}

@Injectable(EFFECT_DEPS)
class InMemoryEffectsOfMine extends InMemoryFencedEffectRepository {}

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

const hintsOf = async (providers: readonly Provider[]): Promise<readonly string[]> =>
  (await violationsOf(providers)).map((line) => line.split("would not stop its write — ")[1] ?? "");

describe("#539 acceptance: a core kind on another database is offered no core store", () => {
  it('fenced effects on "sqlite:reports" beside the in-memory leases: a lease store declaring it, no SQLite class', async () => {
    expect(await hintsOf([ReportsEffects])).toEqual([
      'list it with a lease store declaring backend "sqlite:reports", or list a fenced-effect store declaring backend "in-memory" (InMemoryFencedEffectRepository) in its place',
    ]);
  });

  it('SQLite fenced effects beside leases on "sqlite:reports": no SqliteFencedEffectRepository for the other database', async () => {
    expect(await hintsOf([SqliteFencedEffectRepository, ReportsLeases])).toEqual([
      'list it with a lease store declaring backend "sqlite" (SqliteExecutionLeaseRepository), or list a fenced-effect store declaring backend "sqlite:reports" in its place',
    ]);
  });
});

describe("#539 acceptance: a backend named like an object's own member is only a name", () => {
  it('"constructor" beside SQLite leases, and SQLite calls beside "toString" leases', async () => {
    const hints = [
      ...(await hintsOf([ConstructorEffects, SqliteExecutionLeaseRepository])),
      ...(await hintsOf([SqliteOutboundCallRepository, ToStringLeases])),
    ];

    expect(hints).toEqual([
      'list it with a lease store declaring backend "constructor", or list a fenced-effect store declaring backend "sqlite" (SqliteFencedEffectRepository) in its place',
      'list it with a lease store declaring backend "sqlite" (SqliteExecutionLeaseRepository), or list an outbound-call store declaring backend "toString" in its place',
    ]);
  });
});

describe("#539 acceptance: every store of one contract is named", () => {
  it("three fenced-effect stores: one ambiguity naming the three", async () => {
    const [ambiguity] = await violationsOf([
      PostgresEffects,
      SqliteFencedEffectRepository,
      InMemoryFencedEffectRepository,
      PostgresLeases,
    ]);

    expect(ambiguity).toBe(
      '[di.ambiguous-implementation] 3 listed classes are fenced-effect stores (FencedEffectRepository): PostgresEffects (backend "postgres"), SqliteFencedEffectRepository (backend "sqlite"), InMemoryFencedEffectRepository (backend "in-memory") — list one',
    );
  });

  it("a subclass listed with its parent: two stores, its inherited backend named", async () => {
    expect(await violationsOf([InMemoryFencedEffectRepository, InMemoryEffectsOfMine])).toEqual([
      '[di.ambiguous-implementation] 2 listed classes are fenced-effect stores (FencedEffectRepository): InMemoryFencedEffectRepository (backend "in-memory"), InMemoryEffectsOfMine (backend "in-memory") — list one',
    ]);
  });

  it("two opted-out stores: the ambiguity, neither compared with the leases", async () => {
    expect(
      await violationsOf([UncheckedEffects, UncheckedRedisEffects, SqliteExecutionLeaseRepository]),
    ).toEqual([
      '[di.ambiguous-implementation] 2 listed classes are fenced-effect stores (FencedEffectRepository): UncheckedEffects (no backend), UncheckedRedisEffects (backend "redis") — list one',
    ]);
  });
});

describe("#539 acceptance: every violation at once, in the same order every time", () => {
  it("a mixed layout lists its violations identically on every assembly", async () => {
    const layout = [
      SqliteFencedEffectRepository,
      ReportsEffects,
      SqliteOutboundCallRepository,
      ReportsLeases,
    ];

    const first = await violationsOf(layout);
    const second = await violationsOf(layout);

    expect(first.map((line) => /^\[([^\]]+)\]/u.exec(line)?.[1])).toEqual([
      "di.ambiguous-implementation",
      "application.store-backend-mismatch",
      "application.store-backend-mismatch",
    ]);
    expect(second).toEqual(first);
  });
});
