/**
 * #935 AC2 (I7): the notice and its change are one transaction in SQLite. A trigger — a second
 * connection's own DDL, as a dead disk or a full table would — refuses the notice insert: the
 * change must not stay behind, and no notice without its change either.
 */
import { describe, expect, it } from "vitest";
import { StoreError } from "../../../src/core/error-families/store-errors.js";
import { seconds } from "../../../src/units/index.js";
import { NO_RECIPIENTS } from "../../../src/infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
} from "../../../src/infrastructure/paused-execution.repository.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import {
  RECIPIENTS,
  DEADLINE,
  expiringPauseOf,
  MID,
  withSeen,
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

describe("one mailbox row that does not read does not stop the claim of the others (#1307)", () => {
  it("a notice kind no code writes any more (a store from before the rename: `extended`) is set aside dead", async () => {
    const path = temporarySqlitePath();
    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), new VirtualClock(MID));
    await pauses.findOrCreateByStepKey(expiringPauseOf("pause-a"));
    await pauses.findOrCreateByStepKey(expiringPauseOf("pause-b", "run-1:s:1:b"));
    for (const id of ["pause-a", "pause-b"])
      await pauses.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
    connectionTo(path)
      .database.prepare(
        `UPDATE pause_notices SET notices = REPLACE(notices, '"opened"', '"extended"') WHERE pause_id = 'pause-a'`,
      )
      .run();

    const claims = await pauses.claimNoticesDue(MID, 10, seconds(30), ["listener:audit-listener"]);

    expect(claims.map(({ mailbox }) => mailbox.pauseId)).toEqual(["pause-b"]);
    expect(await pauses.countNotices()).toEqual({ live: 3, dead: 1 });
  });
});

describe("a timeout-changed notice keeps who and why through the store (#1307)", () => {
  it("the claimed notice carries the actor and the masked reason it was written with", async () => {
    const pauses = new SqlitePausedExecutionRepository(
      connectionTo(temporarySqlitePath()),
      new VirtualClock(MID),
    );
    await pauses.findOrCreateByStepKey(expiringPauseOf("pause-a"));
    await pauses.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
    await pauses.changeTimeoutByTenantIdAndPauseId(
      "default",
      "pause-a",
      await withSeen(pauses, "pause-a", {
        expiresAt: new Date("2026-01-05T12:00:00.000Z"),
        previousExpiresAt: DEADLINE,
        actor: { id: "operator-1", orgId: "hq" },
        reason: "customer escalated",
      }),
      MID,
      RECIPIENTS,
    );

    const claims = await pauses.claimNoticesDue(MID, 10, seconds(30), ["listener:audit-listener"]);

    expect(claims.flatMap(({ mailbox }) => mailbox.notices)).toContainEqual(
      expect.objectContaining({
        kind: "timeout-changed",
        actor: { id: "operator-1", orgId: "hq" },
        changeReason: "customer escalated",
      }),
    );
  });
});

describe("#1307, M3: a mailbox row that does not read stops the change of its pause, whole", () => {
  it("a resolve over a pause whose mailbox holds a time not in the canonical spelling is refused as unreadable, and the pause stays pending", async () => {
    const path = temporarySqlitePath();
    const pauses = new SqlitePausedExecutionRepository(connectionTo(path), new VirtualClock(MID));
    await pauses.findOrCreateByStepKey(expiringPauseOf("pause-a"));
    await pauses.markSentByTenantIdAndPauseId("default", "pause-a", RECIPIENTS);
    connectionTo(path)
      .database.prepare("UPDATE pause_notices SET next_attempt_at = '2026-01-05T10:00:00Z'")
      .run();

    await expect(
      pauses.cancelByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Cancelled,
        MID,
        RECIPIENTS,
      ),
    ).rejects.toBeInstanceOf(StoreError.UnreadableRecord);

    expect(await pauses.findByTenantIdAndPauseId("default", "pause-a")).toMatchObject({
      status: PauseStatus.Pending,
    });
  });
});
