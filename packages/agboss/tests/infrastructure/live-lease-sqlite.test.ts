/**
 * #533 item 3 — the SQLite store's check of a lease that wrote a pending outbound call
 * (`sqliteLeaseStateOf`, #508), on a temporary file: `Live` while the lease is held at that token,
 * `Ended` once released, at another token or for a key with no lease, and `Superseded` once — the
 * check closes an expired lease itself, and a second check finds it ended.
 */
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { OutboundCallLeaseState } from "../../src/infrastructure/execution-lease-event.repository.js";
import { sqliteLeaseStateOf } from "../../src/infrastructure/live-lease.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

/** A lease store on a new SQLite file, and the state its check reads now. */
function sqliteLeases() {
  const clock = new VirtualClock();
  const connection = connectionTo(temporarySqlitePath());
  const application = applicationContextOf({
    ...{ name: "live-lease-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new SqliteExecutionLeaseRepository(connection, clock, application);
  const stateOf = (leaseExecutionId: string, token: number): OutboundCallLeaseState =>
    sqliteLeaseStateOf(
      connection.database,
      { tenantId: "default", leaseExecutionId, token },
      clock.now(),
    );
  return { clock, leases, stateOf };
}

async function heldIn(leases: SqliteExecutionLeaseRepository) {
  const lease = await leases.acquire("default", "execution-1", seconds(30));
  if (lease === undefined) throw new Error("the lease is held");
  return lease;
}

describe("#533: sqliteLeaseStateOf", () => {
  it("Live while the lease is held at that token", async () => {
    const { leases, stateOf } = sqliteLeases();
    await heldIn(leases);

    expect(stateOf("execution-1", 1)).toBe(OutboundCallLeaseState.Live);
  });

  it("Ended once its holder released it", async () => {
    const { leases, stateOf } = sqliteLeases();
    await leases.release(await heldIn(leases));

    expect(stateOf("execution-1", 1)).toBe(OutboundCallLeaseState.Ended);
  });

  it("Ended for another token than the one held", async () => {
    const { leases, stateOf } = sqliteLeases();
    await heldIn(leases);

    expect(stateOf("execution-1", 2)).toBe(OutboundCallLeaseState.Ended);
  });

  it("Ended for a key with no lease", () => {
    const { stateOf } = sqliteLeases();

    expect(stateOf("execution-9", 1)).toBe(OutboundCallLeaseState.Ended);
  });

  it("Superseded once, at its expiry: the check closes it, and the next check finds it ended", async () => {
    const { clock, leases, stateOf } = sqliteLeases();
    await heldIn(leases);
    await clock.advance(seconds(30));

    const states = [stateOf("execution-1", 1), stateOf("execution-1", 1)];

    expect(states).toEqual([OutboundCallLeaseState.Superseded, OutboundCallLeaseState.Ended]);
  });
});
