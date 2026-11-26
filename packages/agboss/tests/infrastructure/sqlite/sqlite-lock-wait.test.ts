/**
 * #1317c (money review, finding 4): SQLite across processes. A `runOnce` of one process keeps
 * `BEGIN IMMEDIATE` open across its `execute` (up to 15 s); another process's renewals, checkpoint
 * writes, fenced effects and an operator's cancel wait for it asynchronously — SQLite's own busy wait
 * (which blocks the loop) is off — and fail with a typed `StoreError.LockTimeout`, never a hang,
 * when the wait passes its deadline. Fencing is untouched: the waiting call runs once, after the commit.
 */
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyCheckpoint } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/core/error-families/config-errors.js";
import { StoreError, StoreErrorKind } from "../../../src/core/error-families/store-errors.js";
import { EXECUTION_LEASE } from "../../../src/app/lease-fence.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import {
  SQLITE_HOLD_CAP,
  type SqliteConnection,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteFencedEffectRepository } from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import {
  assertLockWaitBudget,
  LOCK_WAIT_DEADLINE,
  whileBusy,
} from "../../../src/infrastructure/sqlite/sqlite-lock-wait.js";
import { keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, seconds } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { storeClockOf } from "../../helpers/store-clock.js";

/**
 * One instance on `path`. Two spellings of one file's path (the folder and a symlink to it) give two
 * connections that share no mutex — as two processes share none — so SQLite's own file lock is all
 * that stands between them.
 */
function instanceOn(path: string, instanceId: string, clock = new VirtualClock()) {
  const connection = connectionTo(path);
  const application = applicationContextOf({
    name: "lock-wait",
    version: "1.0.0",
    instanceId,
    startedAt: clock.now(),
    profiles: ["test"],
  });
  return {
    connection,
    effects: new SqliteFencedEffectRepository(connection, storeClockOf(clock)),
    leases: new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), application),
    saver: new SqliteCheckpointSaver(connection),
  };
}

function twoProcesses() {
  const path = temporarySqlitePath();
  const alias = join(dirname(path), "alias");
  symlinkSync(dirname(path), alias);
  const clock = new VirtualClock();
  const holder = instanceOn(path, "instance-a", clock);
  const waiter = instanceOn(join(alias, "application.sqlite"), "instance-b", clock);
  return { holder, waiter };
}

const TREE = { tenantId: "default", rootExecutionId: "execution-1" };
const thread: RunnableConfig = { configurable: { thread_id: "thread-1", checkpoint_ns: "" } };

const pause = (length: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, length));

describe("#1317c finding 4: another process's lock is waited for asynchronously (fast cases)", () => {
  it("a lock held past the deadline fails with StoreError.LockTimeout, not a hang, and nothing is applied", async () => {
    const path = temporarySqlitePath();
    const holder = connectionTo(path);
    const alias = join(dirname(path), "alias");
    symlinkSync(dirname(path), alias);
    const waiter = connectionTo(join(alias, "application.sqlite"));
    holder.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");
    holder.database.exec("BEGIN IMMEDIATE");

    const failed = await Promise.resolve(
      whileBusy(
        waiter.database,
        () => {
          waiter.database.exec("BEGIN IMMEDIATE");
          waiter.database.exec("INSERT INTO rows VALUES ('late')");
          waiter.database.exec("COMMIT");
        },
        seconds(0.3),
      ),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    holder.database.exec("COMMIT");

    expect(failed).toBeInstanceOf(StoreError.LockTimeout);
    expect((failed as StoreError).kind).toBe(StoreErrorKind.LockTimeout);
    expect(holder.database.prepare("SELECT count(*) AS n FROM rows").get()).toEqual({ n: 0 });
  });

  it("a try that passes at once answers at once, with no extra tick", () => {
    const connection = connectionTo(temporarySqlitePath());

    expect(whileBusy(connection.database, () => 5)).toBe(5);
  });

  it("a busy answer is tried again, asynchronously, until the lock is free; the call then runs once", async () => {
    const path = temporarySqlitePath();
    const holder = connectionTo(path);
    const alias = join(dirname(path), "alias");
    symlinkSync(dirname(path), alias);
    const waiter = connectionTo(join(alias, "application.sqlite"));
    holder.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");
    holder.database.exec("BEGIN IMMEDIATE");
    let tries = 0;

    const waiting = whileBusy(waiter.database, () => {
      tries += 1;
      waiter.database.exec("BEGIN IMMEDIATE");
      waiter.database.exec("INSERT INTO rows VALUES ('once')");
      waiter.database.exec("COMMIT");
    });
    expect(waiting).toBeInstanceOf(Promise);
    await pause(60);
    expect(tries).toBeGreaterThan(1);
    holder.database.exec("COMMIT");
    await waiting;

    expect(holder.database.prepare("SELECT row FROM rows").all()).toEqual([{ row: "once" }]);
  });

  it("a busy answer inside the connection's own transaction is not a lock wait: it is raised at once", () => {
    const path = temporarySqlitePath();
    const holder = connectionTo(path);
    const alias = join(dirname(path), "alias");
    symlinkSync(dirname(path), alias);
    const waiter = connectionTo(join(alias, "application.sqlite"));
    holder.database.exec("CREATE TABLE IF NOT EXISTS rows (row TEXT)");
    waiter.database.exec("BEGIN");
    waiter.database.prepare("SELECT count(*) FROM rows").get();
    holder.database.exec("BEGIN IMMEDIATE");

    expect(() =>
      whileBusy(waiter.database, () => {
        waiter.database.exec("INSERT INTO rows VALUES ('x')");
      }),
    ).toThrow(/locked/);

    waiter.database.exec("ROLLBACK");
    holder.database.exec("ROLLBACK");
  });

  it("a statement that fails for another reason is raised at once, not retried", async () => {
    const connection = connectionTo(temporarySqlitePath());
    let tries = 0;

    await expect(
      Promise.resolve().then(() =>
        whileBusy(connection.database, () => {
          tries += 1;
          connection.database.exec("INSERT INTO no_such_table VALUES (1)");
        }),
      ),
    ).rejects.toThrow(/outcome is unknown/);
    expect(tries).toBe(1);
  });
});

describe("#1317c finding 4: the wait fits the lease", () => {
  it("the defaults: a hold, then the wait, then the lease", () => {
    expect(SQLITE_HOLD_CAP).toBeLessThan(LOCK_WAIT_DEADLINE);
    expect(LOCK_WAIT_DEADLINE).toBeLessThan(EXECUTION_LEASE);
    expect(() => {
      assertLockWaitBudget({ lease: EXECUTION_LEASE, holdCap: SQLITE_HOLD_CAP });
    }).not.toThrow();
  });

  it("a wait that does not fit the lease, or a hold longer than the wait, is a ConfigError", () => {
    expect(() => {
      assertLockWaitBudget({ lease: seconds(20), holdCap: seconds(15), deadline: seconds(20) });
    }).toThrow(ConfigError.Option);
    expect(() => {
      assertLockWaitBudget({ lease: seconds(30), holdCap: seconds(20), deadline: seconds(20) });
    }).toThrow(ConfigError.Option);
  });

  it("held() refuses a cap the wait cannot cover", async () => {
    const connection: SqliteConnection = connectionTo(temporarySqlitePath());

    expect(() => connection.held(() => 1, seconds(25))).toThrow(ConfigError.Option);
    await expect(connection.held(() => 1, seconds(1))).resolves.toBe(1);
  });
});
