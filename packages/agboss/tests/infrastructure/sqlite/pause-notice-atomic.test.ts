/**
 * #935 AC2 (I7): the notice and its change are one transaction in SQLite. A trigger — a second
 * connection's own DDL, as a dead disk or a full table would — refuses the notice insert: the
 * change must not stay behind, and no notice without its change either.
 */
import { describe, expect, it } from "vitest";
import { NO_RECIPIENTS } from "../../../src/infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
} from "../../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import {
  RECIPIENTS,
  expiringPauseOf,
  MID,
} from "../../../src/testing/contracts/paused-execution-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const BREAK_NOTICES = `CREATE TRIGGER no_notices BEFORE INSERT ON pause_notices BEGIN SELECT RAISE(ABORT, 'disk full'); END;`;

describe("I7: a change and its notices are one transaction", () => {
  it("a notice that cannot be written leaves its change undone: resolve, cancel, markSent", async () => {
    const path = temporarySqlitePath();
    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), new VirtualClock(MID));
    await pauses.findOrCreateByStepKey(expiringPauseOf("pause-a"));
    await pauses.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:b"));
    await pauses.markSentByTenantIdAndPauseId("default", "pause-b", NO_RECIPIENTS);
    connectionTo(path).database.exec(BREAK_NOTICES);

    await expect(
      pauses.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS),
    ).rejects.toThrow("disk full");
    await expect(
      pauses.cancelByTenantIdAndPauseId(
        "default",
        "pause-b",
        PauseResolution.Cancelled,
        MID,
        RECIPIENTS,
      ),
    ).rejects.toThrow("disk full");

    expect(await pauses.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
      isSent: false,
    });
    expect(await pauses.findByTenantIdAndPauseId("default", "pause-b")).toMatchObject({
      status: PauseStatus.Pending,
    });
    expect(await pauses.countNotices()).toEqual({ live: 0, dead: 0 });
  });
});
