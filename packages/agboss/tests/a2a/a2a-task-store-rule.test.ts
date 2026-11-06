/**
 * #824 AC3 — fail closed at assembly: an application that serves A2A (`@A2AExpose`) on a lease
 * store its instances share (any backend but `in-memory`) keeps its A2A tasks where they share them
 * too — the leases' backend, or another backend no single host owns — else
 * `[a2a.task-store-not-shared]` names both stores and the one to list: on each instance's own
 * memory a message resent to another instance would start a second execution. Every pairing of
 * eight lease stores with ten A2A task stores; an application on in-memory leases, or serving no
 * A2A, is never refused.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class, Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { SqliteExecutionLeaseRepository } from "../../src/index.js";
import {
  BillingLeases,
  EmptyLeases,
  PostgresLeases,
  RedisLeases,
  UndeclaredLeases,
} from "../application/fixtures/store-backends.fixture.js";
import {
  a2aStoresApplication,
  BillingA2ATasks,
  CapitalSqliteA2ATasks,
  EmptyA2ATasks,
  LmdbA2ATasks,
  MongoA2ATasks,
  MongoLeases,
  OwnInMemoryA2ATasks,
  PostgresA2ATasks,
  UndeclaredA2ATasks,
} from "./fixtures/a2a-task-stores.fixture.js";

/** The rule violations assembling the application reports: `[]` when it assembles. */
async function violationsOf(
  providers: readonly Provider[],
  options?: { readonly isExposed?: boolean },
): Promise<readonly string[]> {
  try {
    await applicationOf(a2aStoresApplication(providers, options));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

interface Choice {
  readonly name: string;
  /** `undefined`: none listed, the built-in default. */
  readonly listed: Class | undefined;
  readonly backend: string | undefined;
}

const LEASES: readonly Choice[] = [
  { name: "the in-memory default", listed: undefined, backend: "in-memory" },
  { name: "SQLite", listed: SqliteExecutionLeaseRepository, backend: "sqlite" },
  { name: "PostgreSQL", listed: PostgresLeases, backend: "postgres" },
  { name: "a second PostgreSQL database", listed: BillingLeases, backend: "postgres:billing" },
  { name: "MongoDB", listed: MongoLeases, backend: "mongodb" },
  { name: "Redis", listed: RedisLeases, backend: "redis" },
  { name: "no backend", listed: UndeclaredLeases, backend: undefined },
  { name: "an empty backend", listed: EmptyLeases, backend: undefined },
];

const IN_MEMORY_TASKS: Choice = {
  name: "the in-memory default",
  listed: undefined,
  backend: "in-memory",
};

const TASKS: readonly Choice[] = [
  IN_MEMORY_TASKS,
  { name: "a subclass of the in-memory store", listed: OwnInMemoryA2ATasks, backend: "in-memory" },
  { name: "SQLite", listed: SqliteA2ATaskRepository, backend: "sqlite" },
  { name: "PostgreSQL", listed: PostgresA2ATasks, backend: "postgres" },
  { name: "a second PostgreSQL database", listed: BillingA2ATasks, backend: "postgres:billing" },
  { name: "MongoDB", listed: MongoA2ATasks, backend: "mongodb" },
  { name: "no backend", listed: UndeclaredA2ATasks, backend: undefined },
  { name: "an empty backend", listed: EmptyA2ATasks, backend: undefined },
  { name: "a backend no rule knows", listed: LmdbA2ATasks, backend: "lmdb" },
  { name: "a known kind in capitals", listed: CapitalSqliteA2ATasks, backend: "SQLite" },
];

/** The backend kinds known to be shared by the instances of any host. */
const SHARED = new Set(["postgres", "mongodb"]);
const kindOf = (backend: string): string => backend.split(":")[0] ?? backend;

/** Whether the rule lets `tasks` serve beside `leases` (the rule, restated independently). */
function isShared(leases: Choice, tasks: Choice): boolean {
  if (leases.backend === "in-memory") return true;
  if (tasks.backend === undefined) return false;
  return tasks.backend === leases.backend || SHARED.has(kindOf(tasks.backend));
}

const providersOf = (leases: Choice, tasks: Choice): readonly Provider[] =>
  [leases.listed, tasks.listed].filter((cls): cls is Class => cls !== undefined);

const pairings = LEASES.flatMap((leases) =>
  TASKS.map((tasks) => ({
    leases,
    tasks,
    title: `leases on ${leases.name}, A2A tasks on ${tasks.name}`,
  })),
);

describe("#824 AC3: an application serving A2A keeps its tasks where its instances share them", () => {
  it.each(pairings)("$title", async ({ leases, tasks }) => {
    const found = await violationsOf(providersOf(leases, tasks));

    const refusals = found.filter((line) => line.startsWith("[a2a.task-store-not-shared]"));
    if (isShared(leases, tasks)) {
      expect(refusals).toEqual([]);
      return;
    }
    expect(refusals).toHaveLength(1);
    const [refusal] = refusals;
    const leaseName = leases.listed?.name ?? "InMemoryExecutionLeaseRepository";
    const taskName = tasks.listed?.name ?? InMemoryA2ATaskRepository.name;
    expect(refusal).toContain("release-a2a-expose");
    expect(refusal).toContain(leaseName);
    expect(refusal).toContain(taskName);
    expect(refusal).toContain("second execution");
  });

  it.each(LEASES)(
    "serving no A2A, leases on $name never refuse an in-memory task store",
    async (leases) => {
      const found = await violationsOf(providersOf(leases, IN_MEMORY_TASKS), {
        isExposed: false,
      });

      expect(found.filter((line) => line.startsWith("[a2a.task-store-not-shared]"))).toEqual([]);
    },
  );

  it.each([
    [PostgresLeases, "PostgresA2ATaskRepository (@agboss/postgres)"],
    [MongoLeases, "MongoA2ATaskRepository (@agboss/mongodb)"],
    [SqliteExecutionLeaseRepository, "SqliteA2ATaskRepository"],
    [RedisLeases, "Redis keeps no A2A tasks"],
    [UndeclaredLeases, "declares no backend"],
  ])("the refusal beside %o names the fix: %s", async (leases, fix) => {
    const [refusal] = await violationsOf([leases]);

    expect(refusal).toMatch(/^\[a2a\.task-store-not-shared\] /u);
    expect(refusal).toContain(fix);
  });

  it("a backend no rule knows is refused as not known to be shared, never taken as shared", async () => {
    const [refusal] = await violationsOf([PostgresLeases, LmdbA2ATasks]);

    expect(refusal).toContain('LmdbA2ATasks (backend "lmdb"), not known to be shared:');
  });

  it("the full refusal on PostgreSQL leases with the in-memory default", async () => {
    expect(await violationsOf([PostgresLeases])).toEqual([
      '[a2a.task-store-not-shared] a2a-stores-application serves A2A (release-a2a-expose) on PostgresLeases (backend "postgres"), which its instances share, but keeps its A2A tasks in InMemoryA2ATaskRepository (backend "in-memory", the built-in default: none listed), each instance\'s own: a message resent to another instance would start a second execution — list PostgresA2ATaskRepository (@agboss/postgres) in @Application({ providers })',
    ]);
  });
});
