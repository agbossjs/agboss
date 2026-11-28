/**
 * #1356 (pauses-sqlite shard) — the rows of the built-in SQLite pause store read and written on their own: how a
 * pause row and a mailbox row read back, what a text that is no JSON says, a write over a row another writer
 * changed, a claim with no recipient asked of no SQL, and a mailbox claimed under a token with no end.
 */
import { pauseKeyOf } from "../../../src/infrastructure/pause-record.js";
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
      resolvedAt: new Date("2026-11-20T10:00:00.000Z"),
    };

    expect(rows.write(resolved, PauseStatus.Taken)).toBe(false);
    expect(rows.write(resolved, PauseStatus.Pending)).toBe(true);
    expect(rows.write(resolved, PauseStatus.Pending)).toBe(false);
    expect(rows.findById("default", "p-1")).toMatchObject({
      status: PauseStatus.Resolved,
      resolution: PauseResolution.Replied,
      resolvedAt: new Date("2026-11-20T10:00:00.000Z"),
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
      resolved_at: "2026-11-20T10:00:00.001Z",
      expires_at: "2026-11-20T11:00:00.002Z",
      remind_at: "2026-11-20T10:30:00.003Z",
      answer: JSON.stringify({ decision: { approved: false } }),
    });

    expect(read).toMatchObject({
      isSent: true,
      resolvedAt: new Date("2026-11-20T10:00:00.001Z"),
      expiresAt: new Date("2026-11-20T11:00:00.002Z"),
      remindAt: new Date("2026-11-20T10:30:00.003Z"),
      answer: { decision: { approved: false } },
    });
    const bare = toPauseRecord({ ...row, is_sent: 0 });
    expect(bare.isSent).toBe(false);
    for (const field of ["resolvedAt", "expiresAt", "remindAt", "answer"])
      expect(bare).not.toHaveProperty(field);
  });

  it("a column time in another spelling is unreadable, naming the field and never the text (#1307, P6b)", () => {
    const connection = opened();
    new SqlitePauseRows(connection.database).insert(pauseOf("p-1"));
    const row = rowOf(connection, "p-1");

    for (const [column, field] of [
      ["resolved_at", "resolvedAt"],
      ["expires_at", "expiresAt"],
      ["remind_at", "remindAt"],
    ] as const)
      for (const text of ["2026-11-20T10:00:00Z", "2026-11-20T12:00:00.000+02:00", "r-4711"]) {
        const read = (): unknown => toPauseRecord({ ...row, [column]: text });

        expect(read, `${field} ${text}`).toThrow(StoreError.UnreadableRecord);
        expect(read, `${field} ${text}`).toThrow(new RegExp(field));
        expect(read, `${field} ${text}`).not.toThrow(text);
      }
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
      `a stored pause is not readable (pause ${pauseKeyOf("default", "p-1")}): the text is not valid JSON`,
    );
    expect(answer).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(answer).toHaveProperty(
      "message",
      `a stored pause answer is not readable (pause ${pauseKeyOf("default", "p-1")}): the text is not valid JSON`,
    );
  });
});

/** A mailbox row as `pause_notices` keeps it. */
const mailboxRow = (changed: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant_id: "default",
  pause_id: "p-1",
  recipient: "channel:refund",
  notices: JSON.stringify([
    { seq: 1, kind: PauseNoticeKind.Closed, writtenAt: new Date("2026-11-20T09:00:00.000Z") },
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
      notices: [
        { seq: 1, kind: PauseNoticeKind.Closed, writtenAt: new Date("2026-11-20T09:00:00.000Z") },
      ],
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
      headWrittenAt: new Date("2026-11-20T09:00:00.000Z"),
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
      `a stored pause notice mailbox is not readable (pause ${pauseKeyOf("default", "p-1")}): the text is not valid JSON`,
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
      notice: { kind: PauseNoticeKind.Closed, writtenAt: new Date(0) },
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

const NON_CANONICAL = "2026-11-20T10:00:00Z";

/** The error `run` throws, whatever it is; `undefined` when it returns. */
const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#1307: an Invalid Date is refused before a pause row is written", () => {
  const invalidIn = (field: string): PauseRecord => {
    const pause = pauseOf("p-1");
    const first = pause.trail[0];
    const changed: Record<string, Partial<PauseRecord>> = {
      askedAt: { askedAt: new Date(Number.NaN) },
      firstAskedAt: { firstAskedAt: new Date(Number.NaN) },
      maxExpiresAt: { maxExpiresAt: new Date(Number.NaN) },
      boundAt: { boundAt: new Date(Number.NaN) },
      expiresAt: { expiresAt: new Date(Number.NaN) },
      remindAt: { remindAt: new Date(Number.NaN) },
      trail: { trail: first === undefined ? [] : [{ ...first, at: new Date(Number.NaN) }] },
    };
    return { ...pause, ...changed[field] };
  };
  const FIELDS = [
    "askedAt",
    "firstAskedAt",
    "maxExpiresAt",
    "boundAt",
    "expiresAt",
    "remindAt",
    "trail",
  ];

  it("an insert of a pause with one, in the JSON or in a column, throws StoreError.UnreadableRecord and writes nothing", () => {
    const connection = opened();
    const rows = new SqlitePauseRows(connection.database);

    for (const field of FIELDS)
      expect(
        thrownBy(() => {
          rows.insert(invalidIn(field));
        }),
        field,
      ).toBeInstanceOf(StoreError.UnreadableRecord);

    expect(rows.findById("default", "p-1")).toBeUndefined();
  });

  it("a write of one throws the same and leaves the row as it was", () => {
    const connection = opened();
    const rows = new SqlitePauseRows(connection.database);
    const pending = pauseOf("p-1");
    rows.insert(pending);

    for (const field of FIELDS)
      expect(
        thrownBy(() =>
          rows.write({ ...invalidIn(field), status: PauseStatus.Resolved }, PauseStatus.Pending),
        ),
        field,
      ).toBeInstanceOf(StoreError.UnreadableRecord);

    expect(rows.findById("default", "p-1")).toMatchObject({ status: PauseStatus.Pending });
    expect(rowOf(connection, "p-1").pause).not.toContain("null");
  });
});

describe("#1307, M3: a mailbox time is read only in the canonical spelling, naming the field and never the value", () => {
  const message = (run: () => unknown): string => {
    const error = thrownBy(run);
    if (!(error instanceof StoreError.UnreadableRecord)) throw new Error("not unreadable");
    return error.message;
  };

  it("each column of a mailbox row refuses a text that is not what toISOString() writes", () => {
    for (const [column, label] of [
      ["next_attempt_at", "next_attempt_at"],
      ["head_written_at", "head_written_at"],
    ] as const) {
      const text = message(() => toMailbox(mailboxRow({ [column]: NON_CANONICAL })));
      expect(text, column).toContain(label);
      expect(text, column).not.toContain(NON_CANONICAL);
    }
    const claim = message(() =>
      toMailbox(mailboxRow({ claim_token: "t", claimed_until: NON_CANONICAL })),
    );
    expect(claim).toContain("claimed_until");
    expect(claim).not.toContain(NON_CANONICAL);
  });

  it("each time of a notice refuses it too", () => {
    for (const key of ["writtenAt", "closedAt", "expiresAt", "previousExpiresAt"]) {
      const notices = JSON.stringify([
        {
          seq: 1,
          kind: PauseNoticeKind.Closed,
          writtenAt: "2026-11-20T09:00:00.000Z",
          [key]: NON_CANONICAL,
        },
      ]);

      const text = message(() => toMailbox(mailboxRow({ notices })));

      expect(text, key).toContain(key);
      expect(text, key).not.toContain(NON_CANONICAL);
    }
  });

  it("a notice appended to a mailbox row that does not read is refused whole (a mailbox is never rewritten over what it cannot read): the loud choice", () => {
    const connection = opened();
    const rows = new SqlitePauseNoticeRows(connection.database);
    const pause = pauseOf("p-1");
    const planned = {
      recipient: "channel:refund",
      at: new Date("2026-11-20T10:00:00.000Z"),
      notice: { kind: PauseNoticeKind.Closed, writtenAt: new Date("2026-11-20T10:00:00.000Z") },
    };
    rows.append(pause, [planned]);
    connection.database
      .prepare("UPDATE pause_notices SET next_attempt_at = ? WHERE pause_id = ?")
      .run(NON_CANONICAL, "p-1");

    const refused = thrownBy(() => {
      rows.append(pause, [planned]);
    });

    expect(refused).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(
      connection.database
        .prepare("SELECT next_attempt_at, notices FROM pause_notices WHERE pause_id = ?")
        .get("p-1"),
    ).toMatchObject({ next_attempt_at: NON_CANONICAL });
  });
});

describe("#1356: the mailbox statements refuse an Invalid Date naming the field and the record", () => {
  const invalid = new Date(Number.NaN);
  const valid = new Date("2026-11-20T10:00:00.000Z");
  const refusal = (field: string): string =>
    `an Invalid Date was given for ${field} of a pause mailbox: nothing was written (the fields name no stored row; check the clock or the time that was passed)`;
  const rowsOf = () => new SqlitePauseNoticeRows(opened().database);
  const claim = {} as never;

  it.each([
    [
      "claimDue at",
      "at",
      (rows: SqlitePauseNoticeRows) => rows.claimDue(invalid, 1, 1, ["r"], () => "t"),
    ],
    ["ack at", "at", (rows: SqlitePauseNoticeRows) => rows.ack(claim, invalid)],
    ["renew at", "at", (rows: SqlitePauseNoticeRows) => rows.renew(claim, invalid, 1)],
    ["retry", "nextAttemptAt", (rows: SqlitePauseNoticeRows) => rows.retry(claim, invalid, "p")],
    [
      "setAsideStale writtenBefore",
      "writtenBefore",
      (rows: SqlitePauseNoticeRows) => rows.setAsideStale(invalid, valid, "p", 1),
    ],
    [
      "setAsideStale at",
      "at",
      (rows: SqlitePauseNoticeRows) => rows.setAsideStale(valid, invalid, "p", 1),
    ],
  ])("%s", (_name, field, run) => {
    const error = thrownBy(() => run(rowsOf()));

    expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(error).toHaveProperty("message", refusal(field));
    expect(error).toHaveProperty("isInvalidDate", true);
  });
});

describe("#1356: a mailbox that does not read", () => {
  const due = "2026-11-20T10:00:00.000Z";
  const insert = (
    database: ReturnType<typeof opened>["database"],
    values: Record<string, unknown>,
  ) => {
    const row = { ...mailboxRow({ head_written_at: due }), ...values };
    database
      .prepare(
        "INSERT INTO pause_notices (tenant_id, pause_id, recipient, notices, delivered, attempts, next_attempt_at, head_written_at, is_dead, problem, claim_token, claimed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row["tenant_id"] as string,
        row["pause_id"] as never,
        row["recipient"] as string,
        row["notices"] as string,
        row["delivered"] as number,
        row["attempts"] as number,
        row["next_attempt_at"] as string,
        row["head_written_at"] as string,
        row["is_dead"] as number,
        null,
        null,
        null,
      );
  };

  it("with a notice kind no code writes: set aside as dead with the problem `unreadable mailbox`, the claim of the others goes on", () => {
    const { database } = opened();
    insert(database, {
      pause_id: "p-bad",
      notices: JSON.stringify([{ seq: 1, kind: "gone", writtenAt: due }]),
    });
    insert(database, { pause_id: "p-good" });

    const claims = new SqlitePauseNoticeRows(database).claimDue(
      new Date("2026-11-20T10:00:01.000Z"),
      10,
      30_000,
      ["channel:refund"],
      () => "token-1",
    );

    expect(claims.map((c) => c.mailbox.pauseId)).toEqual(["p-good"]);
    expect(
      database.prepare("SELECT is_dead, problem FROM pause_notices WHERE pause_id = 'p-bad'").get(),
    ).toEqual({ is_dead: 1, problem: "unreadable mailbox" });
  });

  it("with no readable key: the reading error is thrown, nothing is set aside", () => {
    const { database } = opened();
    insert(database, { pause_id: new Uint8Array([1, 2]) });

    expect(() =>
      new SqlitePauseNoticeRows(database).claimDue(
        new Date("2026-11-20T10:00:01.000Z"),
        10,
        30_000,
        ["channel:refund"],
        () => "token-1",
      ),
    ).toThrow(/pause_id/);
    expect(database.prepare("SELECT is_dead FROM pause_notices").get()).toEqual({ is_dead: 0 });
  });

  it("notices of a wrong shape: unreadable as a pause notice mailbox, naming the field and the pause, never the value", () => {
    const failure = thrownBy(() =>
      toMailbox(mailboxRow({ notices: JSON.stringify([{ seq: "x", kind: "closed" }]) })),
    );

    expect(failure).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(failure).toHaveProperty("message");
    expect((failure as Error).message).toBe(
      "a stored pause notice mailbox is not readable: the field(s) 0.seq, 0.writtenAt missing or not what the framework wrote",
    );
  });

  it("a due time that is no instant text: unreadable as a pause notice mailbox, naming next_attempt_at", () => {
    const failure = thrownBy(() => toMailbox(mailboxRow({ next_attempt_at: NON_CANONICAL })));

    expect(failure).toBeInstanceOf(StoreError.UnreadableRecord);
    expect((failure as Error).message).toBe(
      "a stored pause notice mailbox is not readable: the field(s) next_attempt_at missing or not what the framework wrote",
    );
  });
});

describe("#1356: the pauses table's indexes", () => {
  it("are all made, the deadline and reminder scans', the tenant's pages', the external reference's and the unsent's", () => {
    const names = opened()
      .database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pauses' AND name LIKE 'pauses_%' ORDER BY name",
      )
      .all()
      .map((row) => row["name"]);

    expect(names).toEqual([
      "pauses_by_external_ref",
      "pauses_by_resolved_at",
      "pauses_by_root",
      "pauses_by_tenant",
      "pauses_pending_by_expiry",
      "pauses_pending_by_remind",
      "pauses_pending_unsent",
    ]);
  });
});
