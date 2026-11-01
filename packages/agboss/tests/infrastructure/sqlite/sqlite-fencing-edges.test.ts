/**
 * #626 — what the SQLite fencing stores do beyond the published contracts, each found by a mutant
 * that lived: they are SQLite implementations (never reused by a later app of a test); each
 * registers its tables under their names, so another store of the file never runs their DDL again;
 * a file an older version wrote gets the `yielded` column; `ping()` asks the file and fails once it
 * is closed; an outbound call's write raises the scope's mark as a fenced effect's does; a pending
 * intent has no `ended_at`; a result whose `then` is no function is a result, not a promise; a
 * replay of the same step names no other; the async-work error has its name.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { ExecutionFencedError } from "../../../src/app/lease-lost.js";
import { FencedEffectStatus } from "../../../src/infrastructure/fenced-effect.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  isSqliteImplementation,
  oneRowChanged,
  type SqliteConnection,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import {
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
} from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import {
  FencedEffectAsyncWorkError,
  SqliteFencedEffectRepository,
} from "../../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { intentOf } from "../../../src/testing/contracts/outbound-call-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

/** One instance's four SQLite fencing stores on a file of the test. */
function storesOn(path = temporarySqlitePath(), clock = new VirtualClock()) {
  const connection = connectionTo(path);
  const application = storesOnContext();
  return {
    connection,
    leases: new SqliteExecutionLeaseRepository(connection, clock, application),
    events: new SqliteExecutionLeaseEventRepository(connection),
    effects: new SqliteFencedEffectRepository(connection, clock, new FencedEffectSettings()),
    calls: new SqliteOutboundCallRepository(connection, clock),
  };
}

type Stores = ReturnType<typeof storesOn>;

async function held(leases: SqliteExecutionLeaseRepository, executionId = "execution-1") {
  const lease = await leases.acquire("default", executionId, hours(1));
  if (lease === undefined) throw new Error("the lease is held");
  return lease;
}

/** The tables each store creates, by the name it registers them under. */
const TABLES: readonly (readonly [string, (connection: SqliteConnection) => unknown])[] = [
  [
    "execution_leases",
    (connection) =>
      new SqliteExecutionLeaseRepository(connection, new VirtualClock(), storesOnContext()),
  ],
  ["execution_lease_events", (connection) => new SqliteExecutionLeaseEventRepository(connection)],
  [
    "execution_leases",
    (connection) =>
      new SqliteFencedEffectRepository(connection, new VirtualClock(), new FencedEffectSettings()),
  ],
  [
    "fenced_effects",
    (connection) =>
      new SqliteFencedEffectRepository(connection, new VirtualClock(), new FencedEffectSettings()),
  ],
  [
    "execution_leases",
    (connection) => new SqliteOutboundCallRepository(connection, new VirtualClock()),
  ],
  [
    "fenced_effects",
    (connection) => new SqliteOutboundCallRepository(connection, new VirtualClock()),
  ],
  [
    "outbound_calls",
    (connection) => new SqliteOutboundCallRepository(connection, new VirtualClock()),
  ],
];

function storesOnContext() {
  return applicationContextOf({
    name: "fencing-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: new Date(0),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
}

const PINGED: readonly (readonly [string, (stores: Stores) => Promise<void>])[] = [
  ["leases", (stores) => stores.leases.ping()],
  ["lease events", (stores) => stores.events.ping()],
  ["fenced effects", (stores) => stores.effects.ping()],
  ["outbound calls", (stores) => stores.calls.ping()],
];

describe("#626: the SQLite fencing stores beyond their contracts", () => {
  it("each is a SQLite implementation: its rows are in the file, never reused by a later app", () => {
    const stores = storesOn();

    for (const store of [stores.leases, stores.events, stores.effects, stores.calls])
      expect({ store: store.constructor.name, isSqlite: isSqliteImplementation(store) }).toEqual({
        store: store.constructor.name,
        isSqlite: true,
      });
  });

  it.each(TABLES)(
    "a store registers %s under its name: another store of the file never runs that DDL again",
    (table, make) => {
      const connection = connectionTo(temporarySqlitePath());
      make(connection);

      expect(() => {
        connection.ensureSchema(table, "NOT A STATEMENT");
      }).not.toThrow();
    },
  );

  it("a file an older version wrote, without the yielded column: the lease store adds it", async () => {
    const path = temporarySqlitePath();
    connectionTo(path).database.exec(`CREATE TABLE execution_leases (
      tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, root_execution_id))`);
    const stores = storesOn(path);

    expect(stores.connection.columnsOf("execution_leases")).toContain("yielded");
    expect(await stores.leases.yield(await held(stores.leases))).toBe(true);
  });

  it.each(PINGED)(
    "ping() of the %s asks the file: answered while open, refused once closed",
    async (_, ping) => {
      const stores = storesOn();
      await expect(ping(stores)).resolves.toBeUndefined();

      stores.connection.onDestroy();

      await expect(ping(stores)).rejects.toThrow();
    },
  );

  it("an outbound call's write raises the scope's mark: after the lease store is wiped, a token below it is refused", async () => {
    const stores = storesOn();
    await stores.leases.release(await held(stores.leases));
    const second = await held(stores.leases);
    expect(second.leaseEpoch).toBe(2);
    expect(await stores.calls.saveIfAbsent(keyOf(second), intentOf(keyOf(second)))).toBe(true);
    // the lease store wiped (its epochs count from 1 again); only the call's write raised the mark
    stores.connection.database.exec("DELETE FROM execution_leases");
    const again = await held(stores.leases);

    const refused = stores.effects.saveResultIfAbsent(keyOf(again, "other"), () => "r1");

    await expect(refused).rejects.toBeInstanceOf(ExecutionFencedError);
    await expect(refused).rejects.toMatchObject({ token: 1, observedToken: 2 });
  });
});

describe("#626: a pending intent, a thenable that is none, a replay, the async-work error", () => {
  it("a pending intent has no ended_at, an ended one has its time: the sweep removes only the ended one", async () => {
    const stores = storesOn();
    const lease = await held(stores.leases);
    const [pending, ended] = [keyOf(lease, "pending"), keyOf(lease, "ended")];
    await stores.calls.saveIfAbsent(pending, intentOf(pending));
    await stores.calls.saveIfAbsent(ended, intentOf(ended));
    await stores.calls.markCompleted(ended, "owner-1", '{"receipt":"r1"}');

    const rows = stores.connection.database
      .prepare("SELECT name, ended_at FROM outbound_calls ORDER BY name")
      .all();
    expect(rows.map((row) => [row.name, row.ended_at === null])).toEqual([
      ["ended", false],
      ["pending", true],
    ]);
    await stores.calls.deleteByEndedAtBefore(new Date(8_640_000_000_000_000));
    expect(await stores.calls.findByKey(pending)).toMatchObject({ name: "pending" });
    expect(await stores.calls.findByKey(ended)).toBeUndefined();
  });

  it("a result whose then is no function is a result, stored and replayed — not a promise", async () => {
    const stores = storesOn();
    const key = keyOf(await held(stores.leases));

    const ran = await stores.effects.saveResultIfAbsent(key, () => ({ then: "later" }));
    const replayed = await stores.effects.saveResultIfAbsent(key, () => ({ then: "never" }));

    expect(ran).toMatchObject({ status: FencedEffectStatus.Ran, result: { then: "later" } });
    expect(replayed).toMatchObject({
      status: FencedEffectStatus.Replayed,
      result: { then: "later" },
    });
  });

  it("the same step's replay names no other step: no replayedFrom at all", async () => {
    const stores = storesOn();
    const key = keyOf(await held(stores.leases));
    await stores.effects.saveResultIfAbsent(key, () => "r1");

    const replayed = await stores.effects.saveResultIfAbsent(key, () => "r2");

    expect(replayed.status).toBe(FencedEffectStatus.Replayed);
    expect(Object.keys(replayed)).not.toContain("replayedFrom");
  });

  it("FencedEffectAsyncWorkError is named so", async () => {
    const stores = storesOn();
    const key = keyOf(await held(stores.leases));

    const call = stores.effects.saveResultIfAbsent(key, () => Promise.resolve("r1"));

    await expect(call).rejects.toBeInstanceOf(FencedEffectAsyncWorkError);
    await expect(call).rejects.toMatchObject({ name: "FencedEffectAsyncWorkError" });
  });

  it("oneRowChanged: true for one row, an Error naming the write for any other count", () => {
    expect(oneRowChanged(1, "a row")).toBe(true);
    expect(oneRowChanged(1n, "a row")).toBe(true);
    expect(() => oneRowChanged(0, "an intent")).toThrow(
      new Error("unreachable: 0 rows changed by a write of an intent"),
    );
    expect(() => oneRowChanged(2n, "an intent")).toThrow(/2 rows/);
  });
});
