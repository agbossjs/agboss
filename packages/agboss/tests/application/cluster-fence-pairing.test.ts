/**
 * #1321e (D6): under a cluster the fencing stores are checked against the database's lease store
 * (the one bound to `EXECUTION_ID_STORE`), not against the cluster's: the database row is what a
 * fenced write is checked by.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { fencedLeaseStoreOf } from "../../src/application/implementations.js";
import { provide } from "../../src/components/injection.js";
import type { Provider } from "../../src/components/injection.js";
import { EXECUTION_ID_STORE } from "../../src/infrastructure/execution-id-store.js";
import {
  PostgresEffects,
  PostgresLeases,
  RedisLeases,
  storesApplication,
} from "./fixtures/store-backends.fixture.js";

async function codesOf(providers: readonly Provider[]): Promise<readonly string[]> {
  try {
    await applicationOf(storesApplication(providers));
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError.GraphRules)) throw error;
    return error.violations.map((found) => found.code);
  }
}

describe("#1321e: the fencing stores pair with the database's lease store under a cluster", () => {
  it("a cluster's lease store beside the database's fencing stores is no mismatch once the database's lease store is the id store", async () => {
    const withIds = [RedisLeases, PostgresEffects, provide(EXECUTION_ID_STORE, PostgresLeases)];

    expect(fencedLeaseStoreOf(withIds)).toBe(PostgresLeases);
    expect(await codesOf(withIds)).not.toContain("application.store-backend-mismatch");
  });

  it("without the database's lease store the cluster's is still what they are checked against", async () => {
    const without = [RedisLeases, PostgresEffects];

    expect(fencedLeaseStoreOf(without)).toBe(RedisLeases);
    expect(await codesOf(without)).toContain("application.store-backend-mismatch");
  });

  it("a fencing store of a third backend still mismatches the database's lease store", async () => {
    const wrong = [RedisLeases, PostgresEffects, provide(EXECUTION_ID_STORE, RedisLeases)];

    expect(await codesOf(wrong)).toContain("application.store-backend-mismatch");
  });
});
