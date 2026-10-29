/**
 * #265 AC7 / AC11, #267 S35 / AC3 / AC12, #481 AC3: `PausedExecutionRepository` — the published
 * paused execution contract (`pausedExecutionContract`), run against the in-memory default (one
 * store shared by both instances) and `SqlitePausedExecutionRepository` (two instances on one file).
 */
import { describe } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { pausedExecutionContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's paused execution stores pass the published contract", () => {
  pausedExecutionContract(
    inMemoryTarget((seam) =>
      sharedInMemory(seam, "paused", () => new InMemoryPausedExecutionRepository()),
    ),
  );
  pausedExecutionContract(
    sqliteTarget(
      ({ clock, connection }) => new SqlitePausedExecutionRepository(connection(), clock),
    ),
  );
});
