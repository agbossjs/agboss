/**
 * #960 AC2 — two listed A2A task stores: assembly refuses the pair, naming both with their
 * backends (`[di.ambiguous-implementation]`, as two lease stores are named), whether or not an
 * `@A2AExpose` is served and whatever the leases are; the task-store rule adds nothing to it.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { PostgresLeases } from "../application/fixtures/store-backends.fixture.js";
import {
  a2aStoresApplication,
  MongoA2ATasks,
  PostgresA2ATasks,
  UndeclaredA2ATasks,
} from "./fixtures/a2a-task-stores.fixture.js";

async function violationsOf(
  providers: readonly Provider[],
  isExposed = true,
): Promise<readonly string[]> {
  try {
    await applicationOf(a2aStoresApplication(providers, { isExposed }));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
}

describe("#960 AC2: two listed A2A task stores", () => {
  it("name both with their backends, beside shared leases, and nothing else", async () => {
    expect(await violationsOf([PostgresA2ATasks, MongoA2ATasks, PostgresLeases])).toEqual([
      '[di.ambiguous-implementation] 2 listed classes are A2A task stores (A2ATaskRepository): PostgresA2ATasks (backend "postgres"), MongoA2ATasks (backend "mongodb") — list one',
    ]);
  });

  it("are refused with no expose and on the in-memory leases too; a store with no backend is named so", async () => {
    expect(await violationsOf([SqliteA2ATaskRepository, UndeclaredA2ATasks], false)).toEqual([
      '[di.ambiguous-implementation] 2 listed classes are A2A task stores (A2ATaskRepository): SqliteA2ATaskRepository (backend "sqlite"), UndeclaredA2ATasks (no backend) — list one',
    ]);
  });

  it("the pairing with the leases is unknown, so the not-shared rule adds nothing to the ambiguity", async () => {
    const found = await violationsOf([SqliteA2ATaskRepository, PostgresA2ATasks, PostgresLeases]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^\[di\.ambiguous-implementation\]/u);
  });

  it("one listed store is no ambiguity", async () => {
    expect(await violationsOf([PostgresA2ATasks, PostgresLeases])).toEqual([]);
  });
});
