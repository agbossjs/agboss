/**
 * #935: the built-in pause stores load their logic on first use. A load that fails (a busy file) is
 * forgotten — the next call tries again —, and the SQLite store makes its tables at construction, so
 * a first call inside a transaction already open on the shared connection needs no transaction of its
 * own to load.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import { usingStore } from "../../../src/infrastructure/lazy-paused-execution.repository.js";
import type { PausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { pauseOf } from "../../../src/testing/contracts/paused-execution-data.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

describe("the first load of a pause store", () => {
  it("a load that fails is not kept: the first call fails, the second succeeds", async () => {
    const owner = {};
    const store = new InMemoryPausedExecutionRepository();
    let loads = 0;
    const load = (): Promise<PausedExecutionRepository> => {
      loads += 1;
      return loads === 1 ? Promise.reject(new Error("SQLITE_BUSY")) : Promise.resolve(store);
    };

    await expect(usingStore(owner, load, (found) => found.ping())).rejects.toThrow("SQLITE_BUSY");
    await expect(usingStore(owner, load, (found) => found.ping())).resolves.toBeUndefined();
    await usingStore(owner, load, (found) => found.ping());

    expect(loads).toBe(2);
  });

  it("a synchronous failure of a store is a rejection", async () => {
    const owner = {};
    const store = new InMemoryPausedExecutionRepository();

    await expect(
      usingStore(
        owner,
        () => Promise.resolve(store),
        () => {
          throw new Error("disk full");
        },
      ),
    ).rejects.toThrow("disk full");
  });

  it("SQLite: the tables exist at construction, and a first call inside an open transaction works", async () => {
    const path = temporarySqlitePath();
    const connection = connectionTo(path);
    const pauses = new SqlitePausedExecutionRepository(connection, new VirtualClock(new Date(0)));
    expect(connection.columnsOf("pauses")).toContain("expires_at");
    expect(connection.columnsOf("pause_notices")).toContain("head_written_at");

    connection.database.exec("BEGIN IMMEDIATE");
    try {
      expect(await pauses.findByTenantIdAndPauseId("default", "pause-a")).toBeUndefined();
    } finally {
      connection.database.exec("ROLLBACK");
    }
    await pauses.findOrCreateByStepKey(pauseOf("pause-a"));
    expect((await pauses.findByTenantIdAndPauseId("default", "pause-a"))?.pauseId).toBe("pause-a");
  });
});
