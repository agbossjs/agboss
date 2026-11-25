/**
 * #1366: the events built from a pause's notice: the time a close is told is its `closedAt` (the
 * notice's `writtenAt` only when it has none), an answer and the person who gave it ride only on a
 * close that carries them (answered; expired with a decision) and never as an empty key, a notice
 * that must name its deadline or its reason and does not is refused (TypeError), and a listener's
 * `expiresAt` is the notice's own, else the pause's.
 */
import { describe, expect, it } from "vitest";
import {
  channelClosedOf,
  channelExpiringOf,
  channelExtendedOf,
  channelNotTakenOf,
  listenerBaseOf,
  listenerClosedOf,
  listenerExpiringOf,
  listenerExtendedOf,
  listenerNotTakenOf,
  listenerOpenedOf,
} from "../../../src/app/pause-notices.js";
import {
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
} from "../../../src/infrastructure/pause-record.js";
import { PauseNoticeKind, type PauseNotice } from "../../../src/infrastructure/pause-notices.js";
import { pauseOf } from "../../../src/testing/contracts/paused-execution-data.js";

const WRITTEN = "2026-01-05T10:00:00.000Z";
const CLOSED = "2026-01-05T09:00:00.000Z";

const answered: PauseRecord = {
  ...pauseOf("p-1"),
  status: PauseStatus.Resolved,
  isSent: true,
  resolution: PauseResolution.Replied,
  answer: { decision: { approved: true }, actor: { id: "manager-17" } },
};
const noOne: PauseRecord = {
  ...answered,
  answer: { decision: { approved: true }, actor: undefined },
};
const unanswered: PauseRecord = { ...answered, answer: undefined };

const notice = (facts: Partial<PauseNotice>): PauseNotice => ({
  seq: 1,
  kind: PauseNoticeKind.Closed,
  writtenAt: WRITTEN,
  ...facts,
});

const sources = (pause: PauseRecord, one: PauseNotice) => ({
  pause,
  notice: one,
  deliveryId: "d-1",
  masked: (value: unknown): Promise<unknown> => Promise.resolve(value),
});

const keysOf = (event: object): string[] => Object.keys(event).sort();

describe("#1366: a close's time and answer", () => {
  it("the time told is closedAt, else writtenAt (channel and listener, closed and not taken)", async () => {
    const withClosed = notice({ reason: PauseClosedReason.Answered, closedAt: CLOSED });
    const without = notice({ reason: PauseClosedReason.Answered });
    const untaken = (one: PauseNotice): PauseNotice => ({
      ...one,
      kind: PauseNoticeKind.AnswerNotTaken,
      reason: PauseClosedReason.Cancelled,
    });

    expect((await channelClosedOf(sources(answered, withClosed))).closedAt).toBe(CLOSED);
    expect((await channelClosedOf(sources(answered, without))).closedAt).toBe(WRITTEN);
    expect((await listenerClosedOf(sources(answered, withClosed), false)).closedAt).toBe(CLOSED);
    expect((await listenerClosedOf(sources(answered, without), false)).closedAt).toBe(WRITTEN);
    expect((await channelNotTakenOf(sources(answered, untaken(withClosed)))).at).toBe(CLOSED);
    expect((await channelNotTakenOf(sources(answered, untaken(without)))).at).toBe(WRITTEN);
    expect((await listenerNotTakenOf(sources(answered, untaken(withClosed)), false)).at).toBe(
      CLOSED,
    );
    expect((await listenerNotTakenOf(sources(answered, untaken(without)), false)).at).toBe(WRITTEN);
  });

  it("a close carries the answer only when it is answered or expired and an answer exists", async () => {
    for (const make of [
      (pause: PauseRecord, one: PauseNotice) => channelClosedOf(sources(pause, one)),
      (pause: PauseRecord, one: PauseNotice) => listenerClosedOf(sources(pause, one), false),
    ]) {
      // cancelled with an answer on the record: no answer, no answeredBy
      const cancelled = await make(answered, notice({ reason: PauseClosedReason.Cancelled }));
      expect(keysOf(cancelled)).not.toContain("answer");
      expect(keysOf(cancelled)).not.toContain("answeredBy");
      // answered / expired with no answer on the record: none either
      for (const reason of [PauseClosedReason.Answered, PauseClosedReason.Expired]) {
        const event = await make(unanswered, notice({ reason }));
        expect(keysOf(event)).not.toContain("answer");
        expect(keysOf(event)).not.toContain("answeredBy");
      }
      // expired with a decision: the answer, never the person
      const expired = await make(answered, notice({ reason: PauseClosedReason.Expired }));
      expect(expired).toMatchObject({ answer: { approved: true } });
      expect(keysOf(expired)).not.toContain("answeredBy");
      // answered: the answer and the person
      const done = await make(answered, notice({ reason: PauseClosedReason.Answered }));
      expect(done).toMatchObject({ answer: { approved: true }, actor: { id: "manager-17" } });
      // answered by no one named: no empty answeredBy key
      const anonymous = await make(noOne, notice({ reason: PauseClosedReason.Answered }));
      expect(keysOf(anonymous)).toContain("answer");
      expect(keysOf(anonymous)).not.toContain("answeredBy");
    }
  });

  it("an answer not taken tells who answered only when someone did, and takes a record with no answer", async () => {
    const untaken = notice({
      kind: PauseNoticeKind.AnswerNotTaken,
      reason: PauseClosedReason.TreeEnded,
    });
    for (const make of [
      (pause: PauseRecord) => channelNotTakenOf(sources(pause, untaken)),
      (pause: PauseRecord) => listenerNotTakenOf(sources(pause, untaken), false),
    ]) {
      expect(await make(answered)).toMatchObject({
        actor: { id: "manager-17" },
        answer: { approved: true },
      });
      expect(keysOf(await make(noOne))).not.toContain("answeredBy");
      const none = await make(unanswered);
      expect(keysOf(none)).not.toContain("answeredBy");
      expect(none).toMatchObject({ reason: PauseClosedReason.TreeEnded });
    }
  });

  it("an answer not taken names a cancel or a tree's end; any other reason is refused", async () => {
    for (const reason of [PauseClosedReason.Answered, PauseClosedReason.Expired, undefined]) {
      const bad = notice({ kind: PauseNoticeKind.AnswerNotTaken, reason });
      await expect(channelNotTakenOf(sources(answered, bad))).rejects.toThrow(TypeError);
      await expect(listenerNotTakenOf(sources(answered, bad), false)).rejects.toThrow(TypeError);
    }
  });
});

describe("#1366: deadlines", () => {
  it("expiring and extended events carry the notice's deadlines; one without them is refused", async () => {
    const extended = notice({
      kind: PauseNoticeKind.Extended,
      expiresAt: "2026-02-01T00:00:00.000Z",
      previousExpiresAt: "2026-01-20T00:00:00.000Z",
    });
    const deadline = { expiresAt: "2026-02-01T00:00:00.000Z" };
    const both = { ...deadline, previousExpiresAt: "2026-01-20T00:00:00.000Z" };
    expect(channelExtendedOf(sources(answered, extended))).toMatchObject(both);
    expect(await listenerExtendedOf(sources(answered, extended), false)).toMatchObject(both);
    expect(channelExpiringOf(sources(answered, extended))).toMatchObject(deadline);
    expect(await listenerExpiringOf(sources(answered, extended), false)).toMatchObject(deadline);

    const noDeadline = notice({ kind: PauseNoticeKind.Expiring });
    const noPrevious = notice({ kind: PauseNoticeKind.Extended, expiresAt: deadline.expiresAt });
    expect(() => channelExpiringOf(sources(answered, noDeadline))).toThrow(TypeError);
    expect(() => channelExtendedOf(sources(answered, noDeadline))).toThrow(TypeError);
    expect(() => channelExtendedOf(sources(answered, noPrevious))).toThrow(TypeError);
    await expect(listenerExpiringOf(sources(answered, noDeadline), false)).rejects.toThrow(
      TypeError,
    );
    await expect(listenerExtendedOf(sources(answered, noPrevious), false)).rejects.toThrow(
      TypeError,
    );
  });

  it("a listener's expiresAt is the notice's, else the pause's, else absent", async () => {
    const pause = { ...answered, expiresAt: "2026-03-01T00:00:00.000Z" };
    const own = notice({ kind: PauseNoticeKind.Extended, expiresAt: "2026-02-01T00:00:00.000Z" });
    const plain = notice({ kind: PauseNoticeKind.Opened });

    expect((await listenerBaseOf(sources(pause, own), false)).expiresAt).toBe(own.expiresAt);
    expect((await listenerOpenedOf(sources(pause, plain), false)).expiresAt).toBe(pause.expiresAt);
    const none = await listenerOpenedOf(
      sources({ ...answered, expiresAt: undefined }, plain),
      false,
    );
    expect(keysOf(none)).not.toContain("expiresAt");
  });
});
