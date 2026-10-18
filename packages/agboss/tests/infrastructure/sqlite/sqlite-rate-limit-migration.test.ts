/**
 * #266 S58 / #265 S52: the windows and pauses of `SqliteRateLimitRepository` are new tables — a
 * file an older version wrote (only `rate_limit_slots`) gets them on open, its slots kept.
 */
import { describe, expect, it } from "vitest";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { SqliteRateLimitRepository } from "../../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const clock = new VirtualClock(new Date(0));
const application = applicationContextOf({
  name: "migration-application",
  version: "1.0.0",
  instanceId: "instance-1",
  startedAt: new Date(0),
  environmentName: "test",
  environment: NO_ENVIRONMENT_VALUES,
});

describe("#266 S58: a rate-limit file from before windows and pauses", () => {
  it("is migrated on open: the new tables are added, its slots kept", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE rate_limit_slots (
      slot_id TEXT PRIMARY KEY, slot_key TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL);
      INSERT INTO rate_limit_slots VALUES ('slot-1', 'p:slots', 'instance-0', 60000);`);
    const connection = connectionTo(path);

    const repository = new SqliteRateLimitRepository(connection, clock, application);

    expect(await repository.acquire("p:slots", 1, seconds(30))).toBeUndefined();
    expect(await repository.addToWindow("p:tokens", 15, seconds(60))).toBe(15);
    await repository.pauseUntil("p:cooldown", new Date(5000));
    expect(await repository.pausedUntil("p:cooldown")).toEqual(new Date(5000));
    expect(connection.columnsOf("rate_limit_window_entries")).toEqual([
      "window_key",
      "counted_at",
      "amount",
    ]);
    expect(connection.columnsOf("rate_limit_pauses")).toEqual(["pause_key", "paused_until"]);
  });
});
