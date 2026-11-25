/**
 * #1356 (pauses-sqlite shard) — the rows of the built-in SQLite pause store read and written on their own: how a
 * pause row and a mailbox row read back, what a text that is no JSON says, a write over a row another writer
 * changed, a claim with no recipient asked of no SQL, and a mailbox claimed under a token with no end.
 */
import { StoreError } from "../../../src/core/error-families/store-errors.js";
import { describe, expect, it, vi } from "vitest";
import {
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../../src/infrastructure/pause-record.js";
import { PauseNoticeKind } from "../../../src/infrastructure/pause-notices.js";
import { SqlitePauseNoticeRows } from "../../../src/infrastructure/sqlite/sqlite-pause-notice-rows.js";
import { toMailbox } from "../../../src/infrastructure/sqlite/sqlite-pause-notice-schema.js";
import {
  SqlitePauseRows,
  toPauseRecord,
} from "../../../src/infrastructure/sqlite/sqlite-pause-row-statements.js";
import { pauseOf } from "../../../src/testing/contracts/paused-execution-data.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

/** A connection to a new file with the pause tables made. */
function opened() {
  return connectionTo(temporarySqlitePath());
}

/** The row `pauses` keeps for the pause with `id`. */
const rowOf = (connection: ReturnType<typeof opened>, id: string): Record<string, unknown> => {
  const row = connection.database.prepare("SELECT * FROM pauses WHERE pause_id = ?").get(id);
  if (row === undefined) throw new Error(`no row of ${id}`);
  return { ...row };
};

describe("#1356: a pause row", () => {
  it("is written over only while it is the status it was read as", () => {
    const connection = opened();
    const rows = new SqlitePauseRows(connection.database);
    const pending = pauseOf("p-1");
    rows.insert(pending);
    const resolved: PauseRecord = {
      ...pending,
      status: PauseStatus.Resolved,
      answer: { decision: { approved: true }, actor: undefined },
      resolution: PauseResolution.Replied,
      resolvedAt: "2026-11-20T10:00:00.000Z",
    };

    expect(rows.write(resolved, PauseStatus.Taken)).toBe(false);
    expect(rows.write(resolved, PauseStatus.Pending)).toBe(true);
    expect(rows.write(resolved, PauseStatus.Pending)).toBe(false);
    expect(rows.findById("default", "p-1")).toMatchObject({
      status: PauseStatus.Resolved,
      resolution: PauseResolution.Replied,
      resolvedAt: "2026-11-20T10:00:00.000Z",
    });
  });

  it("a write over a pause that is not there changes nothing and says so", () => {
    const rows = new SqlitePauseRows(opened().database);

    expect(rows.write(pauseOf("p-missing"), PauseStatus.Pending)).toBe(false);
  });

  it("reads its resolution from its column, else from its status and its answer, as a row before #267 S107 says", () => {
    const connection = opened();
    new SqlitePauseRows(connection.database).insert(pauseOf("p-1"));
    const row = rowOf(connection, "p-1");
    const answer = JSON.stringify({ decision: { approved: true } });

    expect(toPauseRecord({ ...row, status: "cancelled", resolution: null }).resolution).toBe(
      PauseResolution.Cancelled,
    );
    expect(toPauseRecord({ ...row, status: "taken", answer, resolution: null }).resolution).toBe(
      PauseResolution.Replied,
    );
    expect(toPauseRecord({ ...row, status: "pending", resolution: null })).not.toHaveProperty(
      "resolution",
    );
    expect(toPauseRecord({ ...row, status: "cancelled", resolution: "withdrawn" }).resolution).toBe(
      PauseResolution.Withdrawn,
    );
    expect(
      toPauseRecord({ ...row, status: "taken", answer, resolution: "decided" }).resolution,
    ).toBe(PauseResolution.Decided);
  });

  it("reads its columns over its JSON: the times, the flag, the answer", () => {
    const connection = opened();
    new SqlitePauseRows(connection.database).insert(pauseOf("p-1"));
    const row = rowOf(connection, "p-1");

    const read = toPauseRecord({
      ...row,
      is_sent: 1,
      resolved_at: "r",
      expires_at: "e",
      remind_at: "m",
      answer: JSON.stringify({ decision: { approved: false } }),
    });

    expect(read).toMatchObject({
      isSent: true,
      resolvedAt: "r",
      expiresAt: "e",
      remindAt: "m",
      answer: { decision: { approved: false } },
    });
    const bare = toPauseRecord({ ...row, is_sent: 0 });
    expect(bare.isSent).toBe(false);
    for (const field of ["resolvedAt", "expiresAt", "remindAt", "answer"])
      expect(bare).not.toHaveProperty(field);
  });

  it("a text that is no JSON is unreadable, naming the record and the pause but never the text", () => {
    const connection = opened();
    new SqlitePauseRows(connection.database).insert(pauseOf("p-1"));
    const row = rowOf(connection, "p-1");
    const unreadable = (changed: Record<string, unknown>): unknown => {
      try {
        return toPauseRecord({ ...row, ...changed });
      } catch (error) {
        return error;
      }
    };

    const pause = unreadable({ pause: "{not json" });
    const answer = unreadable({ answer: "{not json" });

    expect(pause).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(pause).toHaveProperty(
      "message",
      "a stored pause is not readable (pauseId p-1): the text is not valid JSON",
    );
    expect(answer).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(answer).toHaveProperty(
      "message",
      "a stored pause answer is not readable (pauseId p-1): the text is not valid JSON",
    );
  });
});

/** A mailbox row as `pause_notices` keeps it. */
const mailboxRow = (changed: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant_id: "default",
  pause_id: "p-1",
  recipient: "channel:refund",
  notices: JSON.stringify([
    { seq: 1, kind: PauseNoticeKind.Closed, writtenAt: "2026-11-20T09:00:00.000Z" },
  ]),
  delivered: 0,
  attempts: 2,
  next_attempt_at: "2026-11-20T10:00:00.000Z",
  head_written_at: null,
  is_dead: 0,
  problem: null,
  claim_token: null,
  claimed_until: null,
  ...changed,
});

describe("#1356: a mailbox row", () => {
  it("reads as the mailbox it keeps: its notices, counts, due time, and nothing it has no value for", () => {
    const mailbox = toMailbox(mailboxRow());

    expect(mailbox).toStrictEqual({
      tenantId: "default",
      pauseId: "p-1",
      recipient: "channel:refund",
      notices: [{ seq: 1, kind: PauseNoticeKind.Closed, writtenAt: "2026-11-20T09:00:00.000Z" }],
      delivered: 0,
      attempts: 2,
      nextAttemptAt: new Date("2026-11-20T10:00:00.000Z"),
      isDead: false,
    });
  });

  it("reads what it has: a head's time, a problem, a claim, a dead mailbox", () => {
    const mailbox = toMailbox(
      mailboxRow({
        head_written_at: "2026-11-20T09:00:00.000Z",
        problem: "receiver-unknown",
        claim_token: "token-1",
        claimed_until: "2026-11-20T10:05:00.000Z",
        is_dead: 1,
      }),
    );

    expect(mailbox).toMatchObject({
      headWrittenAt: "2026-11-20T09:00:00.000Z",
      problem: "receiver-unknown",
      claim: { token: "token-1", until: new Date("2026-11-20T10:05:00.000Z") },
      isDead: true,
    });
    expect(toMailbox(mailboxRow({ is_dead: 0 })).isDead).toBe(false);
    for (const field of ["headWrittenAt", "problem", "claim"])
      expect(toMailbox(mailboxRow())).not.toHaveProperty(field);
  });

  it("a claim of a token with no end is a broken row, not a mailbox with no claim", () => {
    expect(() => toMailbox(mailboxRow({ claim_token: "token-1", claimed_until: null }))).toThrow(
      "unreachable: a mailbox claimed under a token is claimed until a time",
    );
    expect(
      toMailbox(mailboxRow({ claim_token: null, claimed_until: "2026-11-20T10:05:00.000Z" })),
    ).not.toHaveProperty("claim");
  });

  it("a notices text that is no JSON is unreadable, naming the pause but never the text", () => {
    const failure = ((): unknown => {
      try {
        return toMailbox(mailboxRow({ notices: "[not json" }));
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(failure).toHaveProperty(
      "message",
      "a stored pause notice mailbox is not readable (pauseId p-1): the text is not valid JSON",
    );
  });
});

describe("#1356: the statements of the mailboxes", () => {
  it("a pause keeps a live mailbox until its notices are delivered or the mailbox is set aside, whatever another pause's are", () => {
    const { database } = opened();
    const rows = new SqlitePauseNoticeRows(database);
    const planned = (recipient: string) => ({
      recipient,
      at: new Date(0),
      notice: { kind: PauseNoticeKind.Closed, writtenAt: new Date(0).toISOString() },
    });
    const mine = pauseOf("p-1");
    rows.append(mine, [planned("channel:refund"), planned("listener:metrics")]);
    rows.append(pauseOf("p-2"), [planned("channel:refund")]);

    expect(rows.hasLive("default", "p-1")).toBe(true);
    expect(rows.hasLive("default", "p-none")).toBe(false);
    expect(rows.hasLive("other", "p-1")).toBe(false);
    const boxes = rows.ofPause("default", "p-1");
    for (const box of boxes) rows.put({ ...box, isDead: true });
    expect(rows.hasLive("default", "p-1")).toBe(false);
    expect(rows.hasLive("default", "p-2")).toBe(true);
    // one live mailbox among dead ones keeps it
    const [revived] = boxes;
    if (revived === undefined) throw new Error("no mailbox");
    rows.put({ ...revived, isDead: false });
    expect(rows.hasLive("default", "p-1")).toBe(true);
  });

  it("a claim for no recipient asks the database nothing", () => {
    const { database } = opened();
    const prepare = vi.spyOn(database, "prepare");

    const claims = new SqlitePauseNoticeRows(database).claimDue(
      new Date(0),
      10,
      30_000,
      [],
      () => "token",
    );

    expect(claims).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
});
