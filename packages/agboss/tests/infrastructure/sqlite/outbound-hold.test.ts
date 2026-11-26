/**
 * Bug hunt 2026-11-25, finding 1 (#1317): an outbound call's `markCompleted` awaits its change
 * module before its transaction. A `runOnce` hold that opens in that gap must not fail it: the
 * transaction waits for the hold and runs once it ends.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { keyOf, leaseOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { intentOf } from "../../../src/testing/contracts/outbound-call-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { storeClockOf } from "../../helpers/store-clock.js";

/** A few turns of the event loop: whatever is not queued behind the hold settles meanwhile. */
const turns = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("hunt: outbound call markCompleted vs an open hold", () => {
  // the change module loaded first: markCompleted's await is one short gap the hold falls into
  beforeAll(async () => {
    await import("../../../src/infrastructure/outbound-call-changes.js");
  });

  it("markCompleted racing a hold's start waits for the hold, then completes the intent", async () => {
    const clock = new VirtualClock();
    const connection = connectionTo(temporarySqlitePath());
    const application = applicationContextOf({
      name: "a",
      version: "1.0.0",
      instanceId: "i",
      startedAt: clock.now(),
      profiles: ["test"],
    });
    const leases = new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), application);
    const calls = new SqliteOutboundCallRepository(connection, storeClockOf(clock));
    const key = keyOf(await leaseOf({ leases }));
    expect(await calls.saveIfAbsent(key, intentOf(key))).toBe(true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const marking = calls.markCompleted(key, "owner-1", '"ok"', null);
    const holding = connection.held(async () => {
      await gate;
      return 1;
    });
    let outcome: string | undefined;
    const settled = marking.then(
      (value) => (outcome = String(value)),
      (error: unknown) => (outcome = String(error)),
    );
    await turns();
    // queued behind the hold, not failed inside it
    expect(outcome).toBeUndefined();
    release();
    await holding;
    await settled;
    expect(outcome).toBe("true");
    expect((await calls.findByKey(key))?.status).toBe("completed");
  });
});
