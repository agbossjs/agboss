/**
 * #935: the built-in pause stores are direct classes (no lazy load): a SQLite store makes its tables
 * at construction, and a first call made inside a transaction that rolls back leaves no write.
 */
import { describe, expect, it } from "vitest";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { pauseOf } from "../../../src/testing/contracts/paused-execution-data.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

describe("a SQLite pause store", () => {
  it("has its tables at construction", () => {
    const connection = connectionTo(temporarySqlitePath());
    new SqlitePausedExecutionRepository(connection, new VirtualClock(new Date(0)));

    expect(connection.columnsOf("pauses")).toEqual(expect.arrayContaining(["expires_at", "seq"]));
    expect(connection.columnsOf("pause_notices")).toContain("head_written_at");
  });

  it("a first call inside an open transaction that rolls back leaves no write", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const pauses = new SqlitePausedExecutionRepository(connection, new VirtualClock(new Date(0)));

    connection.database.exec("BEGIN IMMEDIATE");
    const write = pauses.findOrCreateByStepKey(pauseOf("pause-a")).then(
      () => "stored",
      () => "refused",
    );
    connection.database.exec("ROLLBACK");
    await write;

    expect(await pauses.findByTenantIdAndPauseId("default", "pause-a")).toBeUndefined();
  });
});
