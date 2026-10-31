/**
 * #526 acceptance — how a store declares its backend, at assembly: a `static get backend()` is
 * read like a field (one computed from the environment works), one that throws fails assembly
 * rather than passing; a backend that is not a text, or one declared on the instance instead of the
 * class, is no declaration; backends are compared as exact text ("Postgres" is not "postgres"). A
 * subclass inherits its parent's backend and opt-out, and may change either: a SQLite store
 * re-declared on "postgres" beside SQLite leases is a mismatch, a subclass of an opted-out store
 * that opts back in is checked again.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
import type { Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import {
  Clock,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  InMemoryFencedEffectRepository,
  Injectable,
  LeaseCheck,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
} from "../../src/index.js";
import {
  PostgresLeases,
  storesApplication,
  UncheckedEffects,
} from "./fixtures/store-backends.fixture.js";

const EFFECT_DEPS = {
  deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
} as const;

/** The backend computed when it is read, as from a setting. */
const configured = { backend: "postgres" };

@Injectable(EFFECT_DEPS)
class ComputedEffects extends InMemoryFencedEffectRepository {
  static override get backend(): string | undefined {
    return configured.backend;
  }
}

@Injectable(EFFECT_DEPS)
class ThrowingEffects extends InMemoryFencedEffectRepository {
  static override get backend(): string | undefined {
    throw new Error("the backend's setting is not readable");
  }
}

@Injectable(EFFECT_DEPS)
class NumberEffects extends InMemoryFencedEffectRepository {}
// what a JavaScript project may declare: a number where the type says text
Reflect.defineProperty(NumberEffects, "backend", { value: 5 });

@Injectable(EFFECT_DEPS)
class InstanceFieldEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = undefined;
  readonly backend = "postgres";
}

@Injectable(EFFECT_DEPS)
class CapitalisedEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "Postgres";
}

@Injectable({ deps: [SqliteConnection, Clock, FencedEffectSettings] })
class RedeclaredSqliteEffects extends SqliteFencedEffectRepository {
  static override readonly backend: string | undefined = "postgres";
}

@Injectable({ deps: [SqliteConnection, Clock, FencedEffectSettings] })
class OwnSqliteEffects extends SqliteFencedEffectRepository {}

@Injectable(EFFECT_DEPS)
class InheritedOptOut extends UncheckedEffects {}

@Injectable(EFFECT_DEPS)
class OptedBackIn extends UncheckedEffects {
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.Atomic;
}

/** `[code] message` of each rule violation assembling `providers` reports; `[]` when it assembles. */
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

describe("#526 acceptance: a backend declared by a getter", () => {
  it("is read at assembly: the same text as the leases assembles, another is a mismatch", async () => {
    configured.backend = "postgres";
    const matching = await codesOf([ComputedEffects, PostgresLeases]);
    configured.backend = "postgres:billing";
    const other = await violationsOf([ComputedEffects, PostgresLeases]);
    configured.backend = "postgres";

    expect(matching).toEqual([]);
    expect(other).toEqual([
      expect.stringContaining(
        '[application.store-backend-mismatch] ComputedEffects (backend "postgres:billing")',
      ),
    ]);
  });

  it("that throws fails assembly with its error — never an application that assembles", async () => {
    await expect(
      applicationOf(storesApplication([ThrowingEffects, PostgresLeases])),
    ).rejects.toThrow("the backend's setting is not readable");
  });
});

describe("#526 acceptance: what is no declaration, and what is another backend", () => {
  it.each([
    ["a number", NumberEffects],
    ["a field of the instance, not of the class", InstanceFieldEffects],
  ] as const)("a backend that is %s is undeclared, named", async (_what, Store) => {
    expect(await violationsOf([Store, PostgresLeases])).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\\[application\\.store-backend-undeclared\\] ${Store.name} declares no backend`,
          "u",
        ),
      ),
    ]);
  });

  it('backends are exact text: "Postgres" beside "postgres" is a mismatch', async () => {
    expect(await codesOf([CapitalisedEffects, PostgresLeases])).toEqual([
      "application.store-backend-mismatch",
    ]);
  });
});

describe("#526 acceptance: subclassed stores", () => {
  it("a subclass of the SQLite store inherits its backend: beside SQLite leases it assembles", async () => {
    expect(await codesOf([OwnSqliteEffects, SqliteExecutionLeaseRepository])).toEqual([]);
  });

  it("a subclass that re-declares another backend is checked by its own: a mismatch naming it", async () => {
    expect(await violationsOf([RedeclaredSqliteEffects, SqliteExecutionLeaseRepository])).toEqual([
      expect.stringContaining(
        '[application.store-backend-mismatch] RedeclaredSqliteEffects (backend "postgres") checks its leases in its own transaction, but the application\'s leases are in SqliteExecutionLeaseRepository (backend "sqlite")',
      ),
    ]);
  });

  it("a subclass of an opted-out store inherits the opt-out: not checked, and it warns", async () => {
    expect(await codesOf([InheritedOptOut, PostgresLeases])).toEqual([]);
    const assembled = await applicationOf(storesApplication([InheritedOptOut, PostgresLeases]));
    expect(
      assemblyWarningsOf(assembled).map(({ code, message }) => `[${code}] ${message}`),
    ).toContainEqual(
      expect.stringMatching(/^\[application\.lease-check-not-atomic\] InheritedOptOut declares/u),
    );
  });

  it("a subclass that opts back in (LeaseCheck.Atomic) is checked again: its missing backend is named", async () => {
    expect(await violationsOf([OptedBackIn, PostgresLeases])).toEqual([
      expect.stringMatching(
        /^\[application\.store-backend-undeclared\] OptedBackIn declares no backend/u,
      ),
    ]);
  });
});
