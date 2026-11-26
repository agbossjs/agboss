/**
 * #1356 (pauses shard) — every transition of a pause as the pure function it is (#935, #910): what it makes of the
 * record and which notices it writes with it, at the edges of the times it compares.
 */
import { timeoutChange } from "../../src/infrastructure/pause-timeout-change.js";
import { describe, expect, it } from "vitest";
import {
  cancelChange,
  closeUntakenChange,
  closing,
  expireChange,
  isOpenAt,
  markSentChange,
  onceNotices,
  remindChange,
  resolveChange,
} from "../../src/infrastructure/pause-transitions.js";
import { seenOf } from "../../src/infrastructure/pause-seen.js";
import { PauseNoticeKind } from "../../src/infrastructure/pause-notices.js";
import {
  ExpiryProblem,
  isExpiredPause,
  PauseClosedReason,
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const T9 = "2026-11-20T09:00:00.000Z";
const T10 = "2026-11-20T10:00:00.000Z";
const T11 = "2026-11-20T11:00:00.000Z";
const T12 = "2026-11-20T12:00:00.000Z";
const AT = new Date(T10);
const RECIPIENTS = { channel: "refund", listeners: ["metrics"] };
const answer = { decision: { approved: true }, actor: { id: "manager-1" } };

/** A pending pause, sent unless it says otherwise. */
const pending = (fields: Partial<PauseRecord> = {}): PauseRecord => ({
  ...pauseOf("p-1"),
  isSent: true,
  ...fields,
});

const kindsOf = (
  change: { notices: readonly { notice: { kind: PauseNoticeKind } }[] } | undefined,
) => change?.notices.map(({ notice }) => notice.kind);

describe("#1356: when a pause takes an answer", () => {
  it("while it is pending and its deadline, if it has one, is after the moment", () => {
    expect(isOpenAt(pending(), AT)).toBe(true);
    expect(isOpenAt(pending({ expiresAt: T11 }), AT)).toBe(true);
    expect(isOpenAt(pending({ expiresAt: T10 }), AT)).toBe(false);
    expect(isOpenAt(pending({ expiresAt: T9 }), AT)).toBe(false);
    expect(isOpenAt(pending({ status: PauseStatus.Resolved }), AT)).toBe(false);
  });

  it("an answer is taken while it is open, and writes `closed` to each receiver only for a sent pause", () => {
    const resolved = resolveChange(pending({ expiresAt: T11 }), answer, AT, RECIPIENTS);

    expect(resolved?.pause).toMatchObject({
      status: PauseStatus.Resolved,
      answer,
      resolution: PauseResolution.Replied,
      resolvedAt: T10,
    });
    expect(resolved?.notices.map(({ recipient }) => recipient)).toEqual([
      "channel:refund",
      "listener:metrics",
    ]);
    expect(kindsOf(resolved)).toEqual([PauseNoticeKind.Closed, PauseNoticeKind.Closed]);
    expect(resolveChange(pending({ isSent: false }), answer, AT, RECIPIENTS)?.notices).toEqual([]);
    expect(resolveChange(pending({ expiresAt: T10 }), answer, AT, RECIPIENTS)).toBeUndefined();
    expect(resolveChange(pending({ expiresAt: T9 }), answer, AT, RECIPIENTS)).toBeUndefined();
  });

  it("the `closed` notice says why and when, and leaves out a time the record has none of", () => {
    const after = {
      ...pending(),
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Withdrawn,
    };

    const withTime = closing(pending(), { ...after, resolvedAt: T10 }, AT, RECIPIENTS);
    const withoutTime = closing(pending(), after, AT, RECIPIENTS);

    expect(withTime.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.Closed,
      writtenAt: T10,
      reason: PauseClosedReason.Withdrawn,
      closedAt: T10,
    });
    expect(withoutTime.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.Closed,
      writtenAt: T10,
      reason: PauseClosedReason.Withdrawn,
    });
    expect(closing(pending({ isSent: false }), after, AT, RECIPIENTS).notices).toEqual([]);
  });
});

describe("#1356: a cancel, an expiry and an untaken close", () => {
  it("a cancel of a pending pause closes it as given; at or after its deadline it expired — except a withdrawal", () => {
    const cancelled = cancelChange(
      pending({ expiresAt: T11 }),
      PauseResolution.Cancelled,
      AT,
      RECIPIENTS,
    );
    const atDeadline = cancelChange(
      pending({ expiresAt: T10 }),
      PauseResolution.Cancelled,
      AT,
      RECIPIENTS,
    );
    const after = cancelChange(
      pending({ expiresAt: T9 }),
      PauseResolution.TreeEnded,
      AT,
      RECIPIENTS,
    );
    const withdrawn = cancelChange(
      pending({ expiresAt: T9 }),
      PauseResolution.Withdrawn,
      AT,
      RECIPIENTS,
    );

    expect(cancelled?.pause.resolution).toBe(PauseResolution.Cancelled);
    expect(atDeadline?.pause.resolution).toBe(PauseResolution.Expired);
    expect(after?.pause.resolution).toBe(PauseResolution.Expired);
    expect(withdrawn?.pause.resolution).toBe(PauseResolution.Withdrawn);
    expect(
      cancelChange(
        pending({ status: PauseStatus.Resolved }),
        PauseResolution.Cancelled,
        AT,
        RECIPIENTS,
      ),
    ).toBeUndefined();
    expect(
      cancelChange(pending(), PauseResolution.Cancelled, AT, RECIPIENTS)?.pause.resolution,
    ).toBe(PauseResolution.Cancelled);
  });

  it("an expiry applies at the deadline and after, never before, and never to a pause with none", () => {
    expect(expireChange(pending({ expiresAt: T11 }), {}, AT, RECIPIENTS)).toBeUndefined();
    expect(expireChange(pending(), {}, AT, RECIPIENTS)).toBeUndefined();
    expect(
      expireChange(pending({ status: PauseStatus.Resolved, expiresAt: T9 }), {}, AT, RECIPIENTS),
    ).toBeUndefined();
    expect(expireChange(pending({ expiresAt: T10 }), {}, AT, RECIPIENTS)?.pause.resolution).toBe(
      PauseResolution.Expired,
    );
    expect(expireChange(pending({ expiresAt: T9 }), {}, AT, RECIPIENTS)?.pause.resolution).toBe(
      PauseResolution.Expired,
    );
  });

  it("an expiry with the channel's answer decides it; without, it expires with why it fell back to fail", () => {
    const decided = expireChange(pending({ expiresAt: T9 }), { answer }, AT, RECIPIENTS);
    const failed = expireChange(
      pending({ expiresAt: T9 }),
      { problem: ExpiryProblem.HandlerFailed },
      AT,
      RECIPIENTS,
    );

    expect(decided?.pause).toMatchObject({
      status: PauseStatus.Resolved,
      resolution: PauseResolution.DecidedOnExpiry,
    });
    expect(failed?.pause).toMatchObject({
      resolution: PauseResolution.Expired,
      expiryProblem: ExpiryProblem.HandlerFailed,
    });
  });

  it("an answer no step took is closed only while resolved; its notice names why and when, and goes only from a sent pause", () => {
    const resolved = pending({
      status: PauseStatus.Resolved,
      answer,
      resolution: PauseResolution.Replied,
      resolvedAt: T9,
    });

    const closed = closeUntakenChange(resolved, PauseResolution.TreeEnded, AT, RECIPIENTS);
    const unsent = closeUntakenChange(
      { ...resolved, isSent: false },
      PauseResolution.Cancelled,
      AT,
      RECIPIENTS,
    );

    expect(closed?.pause).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.TreeEnded,
      closedFirst: { resolution: PauseResolution.Replied, resolvedAt: T9 },
    });
    expect(closed?.notices[0]?.notice).toMatchObject({
      kind: PauseNoticeKind.AnswerNotTaken,
      reason: PauseClosedReason.TreeEnded,
      closedAt: T10,
    });
    expect(
      closeUntakenChange(resolved, PauseResolution.Cancelled, AT, RECIPIENTS)?.notices[0]?.notice,
    ).toMatchObject({ reason: PauseClosedReason.Cancelled });
    expect(unsent?.notices).toEqual([]);
    expect(unsent?.pause.resolution).toBe(PauseResolution.Cancelled);
    expect(
      closeUntakenChange(pending(), PauseResolution.Cancelled, AT, RECIPIENTS),
    ).toBeUndefined();
  });
});

describe("#1356, #1307: a change of a deadline (#1099)", () => {
  /** A change of `pause` to `to` (absent: none), from the deadline it has unless `from` says another (`null`: none). */
  const change = (pause: PauseRecord, to: string | undefined, from?: string | null) => {
    const previous = from === undefined ? pause.expiresAt : (from ?? undefined);
    return timeoutChange(
      pause,
      {
        ...(to === undefined ? {} : { expiresAt: to }),
        ...(previous === undefined ? {} : { previousExpiresAt: previous }),
        remindAt: T11,
        seen: seenOf(pause),
      },
      AT,
      RECIPIENTS,
    );
  };

  it("moves the deadline of an open pause from the one the caller read, to a later one, and tells it", () => {
    const moved = change(pending({ expiresAt: T11 }), T12);

    expect(moved?.pause).toMatchObject({
      expiresAt: T12,
      expiryBound: PauseExpiryBound.Pause,
      remindAt: T11,
    });
    expect(moved?.notices[0]?.notice).toMatchObject({
      kind: PauseNoticeKind.TimeoutChanged,
      expiresAt: T12,
      previousExpiresAt: T11,
    });
    expect(kindsOf(moved)).toEqual([
      PauseNoticeKind.TimeoutChanged,
      PauseNoticeKind.TimeoutChanged,
    ]);
  });

  it("moves it to an earlier one just the same, but after the moment", () => {
    const shorter = change(pending({ expiresAt: T12 }), T11);

    expect(shorter?.pause.expiresAt).toBe(T11);
    expect(shorter?.notices[0]?.notice).toMatchObject({ expiresAt: T11, previousExpiresAt: T12 });
    expect(change(pending({ expiresAt: T11 }), "2026-11-20T10:00:00.001Z")).toBeDefined();
  });

  it("sets one on a pause with none, and takes it away: the notice names only the deadline there is", () => {
    const set = change(pending(), T12);
    const taken = change(pending({ expiresAt: T11 }), undefined);

    expect(set?.pause.expiresAt).toBe(T12);
    expect(set?.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.TimeoutChanged,
      writtenAt: AT.toISOString(),
      expiresAt: T12,
    });
    expect(taken?.pause.expiresAt).toBeUndefined();
    expect(taken?.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.TimeoutChanged,
      writtenAt: AT.toISOString(),
      previousExpiresAt: T11,
    });
    expect(change(pending(), undefined)?.pause.expiresAt).toBeUndefined();
  });

  it("writes the actor, the reason and the new deadline into the chain of custody, once per change", () => {
    const record = pending({ expiresAt: T11, assignees: ["m-1"] });
    const moved = timeoutChange(
      record,
      {
        expiresAt: T12,
        previousExpiresAt: T11,
        seen: seenOf(record),
        actor: { id: "manager-17" },
        reason: "customer escalated",
      },
      AT,
      RECIPIENTS,
    );

    expect(moved?.pause.trail).toHaveLength(record.trail.length + 1);
    expect(moved?.pause.trail.at(-1)).toMatchObject({
      action: "timeout-changed",
      at: AT.toISOString(),
      actor: { id: "manager-17" },
      assignees: ["m-1"],
      expiresAt: T12,
      reason: "customer escalated",
    });
    expect(change(record, undefined)?.pause.trail.at(-1)).not.toHaveProperty("expiresAt");
    // the notice carries the same actor and reason: a late delivery must not read them off the chain
    expect(moved?.notices[0]?.notice).toMatchObject({
      actor: { id: "manager-17" },
      changeReason: "customer escalated",
    });
    expect(change(record, T12)?.notices[0]?.notice).not.toHaveProperty("actor");
  });

  it("never to the moment or the past, never from a deadline another writer moved", () => {
    const open = pending({ expiresAt: T11 });

    expect(change(open, T10)).toBeUndefined();
    expect(change(open, T9)).toBeUndefined();
    expect(change(open, T12, T10)).toBeUndefined();
    expect(change(open, T12, null)).toBeUndefined();
    expect(change(pending(), T12, T11)).toBeUndefined();
  });

  it("not more often than the chain's limit: the count is the chain's timeout-changed entries", () => {
    const once = change(pending({ expiresAt: T11 }), T12);
    const limited = (record: PauseRecord, maxExtensions: number) =>
      timeoutChange(
        record,
        {
          expiresAt: T12,
          previousExpiresAt: record.expiresAt ?? "",
          seen: seenOf(record),
          maxExtensions,
        },
        AT,
        RECIPIENTS,
      );

    expect(limited(once?.pause ?? pending(), 1)).toBeUndefined();
    expect(limited(once?.pause ?? pending(), 2)).toBeDefined();
    expect(limited(pending({ expiresAt: T11 }), 1)).toBeDefined();
  });

  it("only while the pause is as the caller read it: trail, assignees, sent mark, deadline (#1307)", () => {
    const record = pending({ expiresAt: T11, assignees: ["a"] });
    const seen = seenOf(record);
    const apply = (now: PauseRecord, read = seen) =>
      timeoutChange(now, { expiresAt: T12, previousExpiresAt: T11, seen: read }, AT, RECIPIENTS);

    expect(apply(record)).toBeDefined();
    expect(apply({ ...record, assignees: ["b"] })).toBeUndefined();
    expect(apply({ ...record, assignees: undefined })).toBeUndefined();
    expect(apply({ ...record, isSent: !record.isSent })).toBeUndefined();
    expect(
      apply({ ...record, trail: [...record.trail, record.trail[0] as never] }),
    ).toBeUndefined();
    // none over none: the deadline is the same, the chain is not
    const none = pending();
    const readNone = seenOf(none);
    const again = timeoutChange(none, { seen: readNone }, AT, RECIPIENTS);
    expect(again).toBeDefined();
    expect(timeoutChange(again?.pause ?? none, { seen: readNone }, AT, RECIPIENTS)).toBeUndefined();
    // a change without what it was read against is refused
    expect(
      timeoutChange(record, { expiresAt: T12, previousExpiresAt: T11 } as never, AT, RECIPIENTS),
    ).toBeUndefined();
  });

  it("set exactly to the deadline the pause was made under it keeps that deadline's source; anywhere else the source is the pause's (L9)", () => {
    const quorum = pending({
      expiresAt: T11,
      expiryBound: PauseExpiryBound.Quorum,
      boundAt: T12,
    });

    expect(change(quorum, T12)?.pause.expiryBound).toBe(PauseExpiryBound.Quorum);
    expect(
      change({ ...quorum, expiryBound: PauseExpiryBound.RunDeadline }, T12)?.pause.expiryBound,
    ).toBe(PauseExpiryBound.RunDeadline);
    expect(change(quorum, "2026-11-20T11:30:00.000Z")?.pause.expiryBound).toBe(
      PauseExpiryBound.Pause,
    );
    expect(change(quorum, undefined)?.pause.expiryBound).toBe(PauseExpiryBound.Pause);
  });

  it("not a pause that is closed, or whose deadline passed", () => {
    expect(change(pending({ status: PauseStatus.Resolved, expiresAt: T11 }), T12)).toBeUndefined();
    expect(change(pending({ expiresAt: T10 }), T12)).toBeUndefined();
    expect(change(pending({ expiresAt: T9 }), T12)).toBeUndefined();
  });
});

describe("#1356: the reminder of a pause", () => {
  it("is due from its time while the deadline is after the moment, and tells the deadline", () => {
    const due = remindChange(pending({ expiresAt: T11, remindAt: T10 }), AT, RECIPIENTS);

    expect(due?.pause.remindAt).toBeUndefined();
    expect(due?.notices[0]?.notice).toMatchObject({
      kind: PauseNoticeKind.Expiring,
      expiresAt: T11,
    });
    expect(remindChange(pending({ expiresAt: T11, remindAt: T9 }), AT, RECIPIENTS)).toBeDefined();
  });

  it("not before its time, not once reminded, not without a deadline, not after the deadline", () => {
    expect(
      remindChange(pending({ expiresAt: T12, remindAt: T11 }), AT, RECIPIENTS),
    ).toBeUndefined();
    expect(remindChange(pending({ expiresAt: T11 }), AT, RECIPIENTS)).toBeUndefined();
    expect(remindChange(pending({ remindAt: T9 }), AT, RECIPIENTS)).toBeUndefined();
    expect(remindChange(pending({ expiresAt: T10, remindAt: T9 }), AT, RECIPIENTS)).toBeUndefined();
    expect(
      remindChange(
        pending({ status: PauseStatus.Resolved, expiresAt: T11, remindAt: T9 }),
        AT,
        RECIPIENTS,
      ),
    ).toBeUndefined();
  });
});

describe("#1356: the channel was asked (rule 2)", () => {
  it("tells the listeners only, once, with the deadline it has, as of the time it was asked", () => {
    const first = markSentChange(
      pending({ isSent: false, expiresAt: T11, askedAt: T9 }),
      RECIPIENTS,
    );

    expect(first.pause.isSent).toBe(true);
    expect(first.notices.map(({ recipient }) => recipient)).toEqual(["listener:metrics"]);
    expect(first.notices[0]?.notice).toStrictEqual({
      kind: PauseNoticeKind.Opened,
      writtenAt: T9,
      expiresAt: T11,
    });
    expect(first.notices[0]?.at).toEqual(new Date(T9));
    expect(
      markSentChange(pending({ isSent: false, askedAt: T9 }), RECIPIENTS).notices[0]?.notice,
    ).toStrictEqual({ kind: PauseNoticeKind.Opened, writtenAt: T9 });
    expect(markSentChange(pending({ isSent: true }), RECIPIENTS).notices).toEqual([]);
  });

  it("a record with no time it was asked at is asked at the epoch", () => {
    const { askedAt: _kept, ...without } = pending({ isSent: false });

    for (const record of [{ ...without, askedAt: "" }, without as PauseRecord])
      expect(markSentChange(record, RECIPIENTS).notices[0]?.at).toEqual(new Date(0));
  });

  it("a pause that closed meanwhile is told as closed, and its untaken answer as not taken", () => {
    const resolved = pending({
      isSent: false,
      status: PauseStatus.Resolved,
      answer,
      resolution: PauseResolution.Replied,
      resolvedAt: T10,
      askedAt: T9,
    });
    const untaken = {
      ...resolved,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.TreeEnded,
      resolvedAt: T11,
      closedFirst: { resolution: PauseResolution.Replied, resolvedAt: T10 },
    };

    expect(kindsOf(markSentChange(resolved, RECIPIENTS))).toEqual([
      PauseNoticeKind.Opened,
      PauseNoticeKind.Closed,
      PauseNoticeKind.Closed,
    ]);
    const told = markSentChange(untaken, RECIPIENTS);
    expect(kindsOf(told)).toEqual([
      PauseNoticeKind.Opened,
      PauseNoticeKind.Closed,
      PauseNoticeKind.Closed,
      PauseNoticeKind.AnswerNotTaken,
      PauseNoticeKind.AnswerNotTaken,
    ]);
    // `closed` is as of the first close, `answerNotTaken` as of the cancel after it
    expect(told.notices[1]?.at).toEqual(new Date(T10));
    expect(told.notices[3]?.at).toEqual(new Date(T11));
    expect(told.notices[3]?.notice).toMatchObject({ reason: PauseClosedReason.TreeEnded });
  });

  it("an answer closed without being taken is not told as such unless it was cancelled or the tree ended; one with no answer, never", () => {
    const closed = (fields: Partial<PauseRecord>) =>
      kindsOf(
        markSentChange(
          pending({ isSent: false, status: PauseStatus.Cancelled, resolvedAt: T10, ...fields }),
          { channel: "refund", listeners: [] },
        ),
      );

    expect(closed({ answer, resolution: PauseResolution.Cancelled })).toContain(
      PauseNoticeKind.AnswerNotTaken,
    );
    expect(closed({ answer, resolution: PauseResolution.Withdrawn })).not.toContain(
      PauseNoticeKind.AnswerNotTaken,
    );
    expect(closed({ resolution: PauseResolution.Cancelled })).not.toContain(
      PauseNoticeKind.AnswerNotTaken,
    );
    expect(closed({ answer })).not.toContain(PauseNoticeKind.AnswerNotTaken);
  });

  it("a notice of a kind goes out for a sent pause only", () => {
    const facts = { launch: "launch-1" };

    expect(onceNotices(pending(), PauseNoticeKind.JoinFailed, facts, AT, RECIPIENTS)).toHaveLength(
      2,
    );
    expect(
      onceNotices(pending({ isSent: false }), PauseNoticeKind.JoinFailed, facts, AT, RECIPIENTS),
    ).toEqual([]);
  });
});

describe("#1356: when a closed record's retention is over", () => {
  const closed = (fields: Partial<PauseRecord>): PauseRecord => ({
    ...pauseOf("p-1"),
    status: PauseStatus.Taken,
    resolvedAt: T9,
    ...fields,
  });

  it("a taken or cancelled record resolved before the cutoff; no other, and none with no time", () => {
    expect(isExpiredPause(closed({}), AT)).toBe(true);
    expect(isExpiredPause(closed({ status: PauseStatus.Cancelled }), AT)).toBe(true);
    expect(isExpiredPause(closed({ resolvedAt: T10 }), AT)).toBe(false);
    expect(isExpiredPause(closed({ resolvedAt: T11 }), AT)).toBe(false);
    expect(isExpiredPause(closed({ status: PauseStatus.Resolved }), AT)).toBe(false);
    expect(isExpiredPause(closed({ status: PauseStatus.Pending }), AT)).toBe(false);
    expect(isExpiredPause(closed({ resolvedAt: undefined }), AT)).toBe(false);
  });
});
