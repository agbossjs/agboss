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
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
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
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
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

describe("#1317c finding 4: another process's lock is waited for asynchronously", () => {
  it("A holds a runOnce for 10 s: B's renewal, cancel and checkpoint land after A's commit, B's loop never blocked", async () => {
    const { holder, waiter } = twoProcesses();
    const lease = await holder.leases.acquire("default", "execution-1", hours(1));
    if (lease === undefined) throw new Error("the lease is held");
    const key = keyOf(lease);
    const committedAt: { value?: number } = {};

    const run = holder.effects
      .runOnce(key, async () => {
        holder.connection
          .requireTransaction()
          .prepare("CREATE TABLE IF NOT EXISTS rows (row TEXT)")
          .run();
        await pause(10_000);
        return { done: true };
      })
      .then((outcome) => {
        committedAt.value = performance.now();
        return outcome;
      });
    await pause(200);
    expect(holder.connection.database.isTransaction).toBe(true);

    // the loop of B keeps running while its calls wait: a timer fires many times
    let ticks = 0;
    let longest = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      ticks += 1;
    }, 20);

    const settledAt: Record<string, number> = {};
    const timed = <TValue>(name: string, call: Promise<TValue>): Promise<TValue> =>
      call.then((value) => {
        settledAt[name] = performance.now();
        return value;
      });
    const renewed = timed("renew", waiter.leases.renew(lease, seconds(30)));
    const cancelled = timed("cancel", waiter.leases.requestCancel(TREE));
    const checkpointed = timed(
      "checkpoint",
      waiter.saver.put(
        thread,
        { ...emptyCheckpoint(), id: "c-1" },
        { source: "loop", step: 0, parents: {} },
      ),
    );

    await run;
    const [left] = await Promise.all([renewed, cancelled, checkpointed]);
    clearInterval(ticker);

    // all three were made after A's commit, not before it
    for (const name of ["renew", "cancel", "checkpoint"])
      expect(settledAt[name]).toBeGreaterThanOrEqual(committedAt.value ?? Infinity);
    // the renewal was confirmed by the store; the cancel mark is durable, the checkpoint is there
    expect(left).toBeGreaterThan(0);
    expect(
      holder.connection.database
        .prepare("SELECT cancel_requested_at IS NOT NULL AS cancelled FROM execution_leases")
        .get(),
    ).toEqual({ cancelled: 1 });
    expect((await holder.saver.getTuple(thread))?.checkpoint.id).toBe("c-1");
    // B's event loop stayed responsive across the ~10 s wait: ticks every ~20 ms, no long gap
    expect(ticks).toBeGreaterThan(200);
    expect(longest).toBeLessThan(500);
  }, 40_000);

  it("fencing stays intact: a renewal waiting through A's hold applies once, for the token it was made with", async () => {
    const { holder, waiter } = twoProcesses();
    const lease = await holder.leases.acquire("default", "execution-1", hours(1));
    if (lease === undefined) throw new Error("the lease is held");
    const run = holder.effects.runOnce(keyOf(lease), async () => {
      await pause(300);
      return { done: true };
    });
    await pause(50);

    const stale = { ...lease, token: lease.token + 1 };
    const renewed = await Promise.all([
      waiter.leases.renew(stale, seconds(30)),
      waiter.leases.renew(lease, seconds(30)),
    ]);
    await run;

    // the lease holder's own token renewed; one made with a token that is not the lease's did not
    expect(renewed[1]).toBeGreaterThan(0);
    expect(renewed[0]).toBeUndefined();
  });
});
