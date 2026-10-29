/**
 * #265 AC1, #481 AC3: `RateLimitRepository` — the published rate limit contract
 * (`rateLimitContract`), run against the in-memory default and `SqliteRateLimitRepository` (two
 * instances on one file), one clock; `ExecutionSlotRepository` does not exist (S27).
 */
import { describe, expect, it } from "vitest";
import * as agboss from "../../src/index.js";
import { InMemoryRateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { SqliteRateLimitRepository } from "../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import { rateLimitContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's rate limit stores pass the published rate limit contract", () => {
  rateLimitContract(
    inMemoryTarget(
      ({ clock, application, database }) =>
        new InMemoryRateLimitRepository(clock, application, database),
    ),
  );
  rateLimitContract(
    sqliteTarget(
      ({ clock, application, connection }) =>
        new SqliteRateLimitRepository(connection(), clock, application),
    ),
  );
});

describe("#265 AC1 (S27): the contracts", () => {
  it("ExecutionSlotRepository does not exist (S27); the three shared contracts do", () => {
    expect("ExecutionSlotRepository" in agboss).toBe(false);
    expect(agboss.RateLimitRepository).toBeTypeOf("function");
    expect(agboss.ExecutionTreeRepository).toBeTypeOf("function");
    expect(agboss.ExecutionLeaseRepository).toBeTypeOf("function");
  });
});
