/**
 * #825 — the SQLite outbound-call store pages on a declared `seq` (`INTEGER PRIMARY KEY
 * AUTOINCREMENT`), not the implicit rowid: a `VACUUM` keeps a cursor's place, a pruned highest row's
 * number is never given again, and a file written before `seq` is rebuilt with its rows in order.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { OutboundCallStatus } from "../../../src/infrastructure/outbound-call.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { effectKeyForTesting } from "../../../src/testing/contracts/effect-key.js";
import { keyOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { intentOf } from "../../../src/testing/contracts/outbound-call-data.js";
import { hours } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const clock = new VirtualClock();
const application = applicationContextOf({
  ...{ name: "seq-application", version: "1.0.0", instanceId: "instance-1" },
  ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
});
const PENDING = { tenantId: "default", status: OutboundCallStatus.Pending } as const;

/** The stores on `path`, and a way to record a pending call named `name`. */
async function storesOn(path: string, executionId = "execution-1") {
  const connection = connectionTo(path);
  const leases = new SqliteExecutionLeaseRepository(connection, clock, application);
  const calls = new SqliteOutboundCallRepository(connection, clock);
  const lease = await leases.acquire("default", executionId, hours(1));
  if (lease === undefined) throw new Error("no lease");
  const record = async (name: string) => {
    const key = effectKeyForTesting(keyOf(lease, name));
    expect(await calls.saveIfAbsent(key, intentOf(key))).toBe(true);
  };
  return { connection, calls, record };
}

const namesOf = (page: { readonly calls: readonly { readonly name: string }[] }) =>
  page.calls.map((call) => call.name);

describe("#825: the SQLite outbound calls page on a declared seq", () => {
  it("a VACUUM after rows are removed keeps a cursor's place: the next page neither repeats nor skips", async () => {
    const { connection, calls, record } = await storesOn(temporarySqlitePath());
    for (const name of ["a", "b", "c", "d", "e"]) await record(name);
    const first = await calls.findAllByTenantIdAndStatus({ ...PENDING, limit: 2 });
    connection.database.exec("DELETE FROM outbound_calls WHERE name IN ('a', 'b')");
    connection.database.exec("VACUUM");

    const second = await calls.findAllByTenantIdAndStatus({
      ...PENDING,
      limit: 2,
      after: first.next,
    });

    expect(namesOf(first)).toEqual(["a", "b"]);
    expect(namesOf(second)).toEqual(["c", "d"]);
  });

  it("the highest row pruned: its number is never given to the next intent", async () => {
    const { connection, calls, record } = await storesOn(temporarySqlitePath());
    await record("a");
    await record("b");
    const first = await calls.findAllByTenantIdAndStatus({ ...PENDING, limit: 1 });
    connection.database.exec("DELETE FROM outbound_calls WHERE name = 'b'");
    await record("c");

    const after = await calls.findAllByTenantIdAndStatus({
      ...PENDING,
      limit: 5,
      after: first.next,
    });

    expect(namesOf(after)).toEqual(["c"]);
    const seqs = connection.database.prepare("SELECT seq FROM outbound_calls ORDER BY seq").all();
    expect(seqs).toEqual([{ seq: 1 }, { seq: 3 }]);
  });

  it("a file written before seq: rebuilt with its rows in order, its indexes, and paged on", async () => {
    const path = temporarySqlitePath();
    const { record } = await storesOn(path);
    for (const name of ["a", "b", "c"]) await record(name);
    const older = new DatabaseSync(path);
    older.exec(`CREATE TABLE before AS SELECT scope_key, idempotency_key, name, tenant_id,
      root_execution_id, status, ended_at, record, business_key FROM outbound_calls ORDER BY seq;
      DROP TABLE outbound_calls; ALTER TABLE before RENAME TO outbound_calls;`);
    older.close();

    const reopened = await storesOn(path, "execution-2");
    const page = await reopened.calls.findAllByTenantIdAndStatus({ ...PENDING, limit: 2 });
    const rest = await reopened.calls.findAllByTenantIdAndStatus({
      ...PENDING,
      limit: 2,
      after: page.next,
    });

    expect(reopened.connection.columnsOf("outbound_calls")).toContain("seq");
    expect(reopened.connection.uniqueIndexesOf("outbound_calls")).toEqual(
      expect.arrayContaining(["scope_key,idempotency_key,name", "tenant_id,name,business_key"]),
    );
    expect([...namesOf(page), ...namesOf(rest)]).toEqual(["a", "b", "c"]);
    await reopened.record("d");
    const all = await reopened.calls.findAllByTenantIdAndStatus({ ...PENDING, limit: 10 });
    expect(namesOf(all)).toEqual(["a", "b", "c", "d"]);
  });
});
