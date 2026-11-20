/**
 * #1356 (pauses shard) — the pure rules of a pause on their own, shared by every store of the core: which bound
 * a deadline has (#942), the key of a replacement (#946), the records the closers make (#935), why and when a
 * pause closed, the scans' limit, filter and cursor, the log entry of an answer and its repair (#939), and the
 * receivers of a notice.
 */
import { describe, expect, it, vi } from "vitest";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { effectiveBoundOf } from "../../src/infrastructure/pause-bound.js";
import {
  answerRecordOf,
  notTakenRecordOf,
  type PauseAnswerLog,
} from "../../src/infrastructure/pause-answer-log.js";
import {
  decidedOnExpiryPause,
  expiredPause,
  untakenPause,
} from "../../src/infrastructure/pause-closers.js";
import {
  closedAtOf,
  closedReasonOf,
  pauseClosedReasonOf,
} from "../../src/infrastructure/pause-closing.js";
import { removeClosedPauses, REPAIR_PAGE } from "../../src/infrastructure/pause-log-repair.js";
import {
  PauseNoticeKind,
  recipientKeysOf,
  type PauseFilter,
} from "../../src/infrastructure/pause-notices.js";
import {
  callIdOfPause,
  ExpiryProblem,
  NO_RECIPIENTS,
  PauseClosedReason,
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
  pauseAnswererOf,
  questionAskOf,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import {
  originalStepKeyOf,
  reassignedPause,
  replacementPause,
  replacementStepKeyOf,
} from "../../src/infrastructure/pause-replacement.js";
import {
  assertPauseFilter,
  assertScanLimit,
  compareText,
  cursorOfSeq,
  matchesFilter,
  MAX_SCAN_LIMIT,
  pageOf,
  seqOfCursor,
} from "../../src/infrastructure/pause-scans.js";
import { pauseOf, questionPauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const AT = new Date("2026-11-20T10:00:00.000Z");
const T9 = "2026-11-20T09:00:00.000Z";
const T10 = AT.toISOString();
const T11 = "2026-11-20T11:00:00.000Z";

describe("#1356: the bound of a deadline (#942)", () => {
  it("a pause extended to the deadline it was made under is the run's deadline: a tie goes to the run", () => {
    const of = (expiresAt?: string, boundAt?: string, expiryBound = PauseExpiryBound.Pause) =>
      effectiveBoundOf({
        expiryBound,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(boundAt === undefined ? {} : { boundAt }),
      });

    expect(of(T10, T10)).toBe(PauseExpiryBound.RunDeadline);
    expect(of(T11, T10)).toBe(PauseExpiryBound.RunDeadline);
    expect(of(T9, T10)).toBe(PauseExpiryBound.Pause);
    expect(of(undefined, T10)).toBe(PauseExpiryBound.Pause);
    expect(of(T10, undefined)).toBe(PauseExpiryBound.Pause);
    expect(of(T10, T10, PauseExpiryBound.Quorum)).toBe(PauseExpiryBound.Quorum);
    expect(of(T10, T10, PauseExpiryBound.RunDeadline)).toBe(PauseExpiryBound.RunDeadline);
    expect(effectiveBoundOf({ expiresAt: T10, boundAt: T10 })).toBeUndefined();
  });
});

describe("#1356: the step key of a replacement (#946)", () => {
  it("is cut of its `~r<n>` only for a replacement, and only at its end", () => {
    expect(originalStepKeyOf({ stepKey: "run-1:s:1~r2", reassignedFrom: "p-1" })).toBe("run-1:s:1");
    expect(originalStepKeyOf({ stepKey: "run-1:s:1~r2" })).toBe("run-1:s:1~r2");
    expect(originalStepKeyOf({ stepKey: "run-1~r2:s:1~r3", reassignedFrom: "p-1" })).toBe(
      "run-1~r2:s:1",
    );
    expect(originalStepKeyOf({ stepKey: "run-1:s:1~r12", reassignedFrom: "p-1" })).toBe(
      "run-1:s:1",
    );
    expect(originalStepKeyOf({ stepKey: "run-1~r2:s", reassignedFrom: "p-1" })).toBe("run-1~r2:s");
    expect(originalStepKeyOf({ stepKey: "run-1:s~r", reassignedFrom: "p-1" })).toBe("run-1:s~r");
  });

  it("is the original with the lowest `~r<n>` no pause of the tree has taken", () => {
    const next = (pause: { stepKey: string; reassignedFrom?: string }, taken: string[]) =>
      replacementStepKeyOf(pause, new Set(taken));

    expect(next({ stepKey: "s" }, [])).toBe("s~r1");
    expect(next({ stepKey: "s" }, ["s~r1"])).toBe("s~r2");
    expect(next({ stepKey: "s~r1", reassignedFrom: "p" }, ["s~r1"])).toBe("s~r2");
    expect(next({ stepKey: "s~r2", reassignedFrom: "p" }, ["s~r2", "s~r1", "s~r3"])).toBe("s~r4");
    expect(next({ stepKey: "s" }, ["s~r2"])).toBe("s~r1");
  });

  it("the old pause is `Cancelled` as `Reassigned`, pointing at its replacement, resolved at once", () => {
    const old = pauseOf("p-1");

    expect(reassignedPause(old, "p-2", AT)).toStrictEqual({
      ...old,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Reassigned,
      resolvedAt: T10,
      reassignedTo: "p-2",
    });
  });

  it("the replacement is `Pending` and unsent, asked now, for its addressee, a copy of the old one otherwise", () => {
    const old = {
      ...pauseOf("p-1"),
      status: PauseStatus.Cancelled,
      isSent: true,
      expiresAt: T11,
      remindAt: T10,
    };

    const made = replacementPause(old, { pauseId: "p-2", assignee: "anna", stepKey: "k~r1" }, AT);

    expect(made).toStrictEqual({
      ...old,
      pauseId: "p-2",
      assignee: "anna",
      stepKey: "k~r1",
      status: PauseStatus.Pending,
      isSent: false,
      askedAt: T10,
      reassignedFrom: "p-1",
    });
  });
});

describe("#1356: the records the closers of a pause make (#935)", () => {
  const pending = pauseOf("p-1");
  const answer = { decision: { approved: true }, answeredBy: "manager-1" };

  it("an expired pause is `Cancelled` as `Expired`, with why it fell back to fail only when it did", () => {
    expect(expiredPause(pending, AT, undefined)).toStrictEqual({
      ...pending,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
      resolvedAt: T10,
    });
    expect(expiredPause(pending, AT, ExpiryProblem.HandlerTimeout)).toHaveProperty(
      "expiryProblem",
      ExpiryProblem.HandlerTimeout,
    );
  });

  it("a pause its channel decided on expiry is `Resolved`, the answer kept without who gave it", () => {
    expect(decidedOnExpiryPause(pending, answer, AT)).toStrictEqual({
      ...pending,
      status: PauseStatus.Resolved,
      answer: { decision: { approved: true }, answeredBy: undefined },
      resolution: PauseResolution.DecidedOnExpiry,
      resolvedAt: T10,
    });
  });

  it("an answer no step took is `Cancelled` as given, keeping how and when it first closed", () => {
    const resolved = {
      ...pending,
      status: PauseStatus.Resolved,
      answer,
      resolution: PauseResolution.Replied,
      resolvedAt: T9,
    };

    expect(untakenPause(resolved, PauseResolution.TreeEnded, AT)).toStrictEqual({
      ...resolved,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.TreeEnded,
      resolvedAt: T10,
      closedFirst: { resolution: PauseResolution.Replied, resolvedAt: T9 },
    });
  });

  it("keeps no first close for a record that has no resolution, or no time of one", () => {
    const noResolution = untakenPause(
      { ...pending, resolvedAt: T9 },
      PauseResolution.Cancelled,
      AT,
    );
    const noTime = untakenPause(
      { ...pending, resolution: PauseResolution.Replied },
      PauseResolution.Cancelled,
      AT,
    );

    expect(noResolution).not.toHaveProperty("closedFirst");
    expect(noTime).not.toHaveProperty("closedFirst");
  });
});

describe("#1356: why and when a pause closed", () => {
  const closed = (fields: Partial<PauseRecord>): PauseRecord => ({
    ...pauseOf("p-1"),
    status: PauseStatus.Cancelled,
    ...fields,
  });
  const answer = { decision: { approved: true }, answeredBy: undefined };

  it.each([
    [PauseResolution.Decided, PauseClosedReason.Answered],
    [PauseResolution.Replied, PauseClosedReason.Answered],
    [PauseResolution.Withdrawn, PauseClosedReason.Withdrawn],
    [PauseResolution.Cancelled, PauseClosedReason.Cancelled],
    [PauseResolution.TreeEnded, PauseClosedReason.TreeEnded],
    [PauseResolution.Expired, PauseClosedReason.Expired],
    [PauseResolution.DecidedOnExpiry, PauseClosedReason.Expired],
    [PauseResolution.Reassigned, PauseClosedReason.Reassigned],
  ])("a pause closed as %s says %s", (resolution, reason) => {
    expect(closedReasonOf(closed({ resolution }))).toBe(reason);
  });

  it("a cancel or tree end that kept an answer says the pause was answered", () => {
    for (const resolution of [PauseResolution.Cancelled, PauseResolution.TreeEnded])
      expect(closedReasonOf(closed({ resolution, answer }))).toBe(PauseClosedReason.Answered);
    expect(closedReasonOf(closed({ resolution: PauseResolution.Withdrawn, answer }))).toBe(
      PauseClosedReason.Withdrawn,
    );
    expect(closedReasonOf(closed({ resolution: PauseResolution.Expired, answer }))).toBe(
      PauseClosedReason.Expired,
    );
  });

  it("the first close names the reason, whatever closed it after", () => {
    const record = closed({
      resolution: PauseResolution.Cancelled,
      answer,
      closedFirst: { resolution: PauseResolution.DecidedOnExpiry, resolvedAt: T9 },
    });

    expect(closedReasonOf(record)).toBe(PauseClosedReason.Expired);
  });

  it("a record written before resolutions says by its status: cancelled, or else answered", () => {
    expect(closedReasonOf(closed({}))).toBe(PauseClosedReason.Cancelled);
    expect(closedReasonOf(closed({ status: PauseStatus.Taken }))).toBe(PauseClosedReason.Answered);
    expect(closedReasonOf(closed({ status: PauseStatus.Resolved }))).toBe(
      PauseClosedReason.Answered,
    );
  });

  it("a pending pause has none until its deadline is over, then it expired", () => {
    const pending = (expiresAt?: string): PauseRecord => ({
      ...pauseOf("p-1"),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });

    expect(pauseClosedReasonOf(pending(), AT)).toBeUndefined();
    expect(pauseClosedReasonOf(pending(T11), AT)).toBeUndefined();
    expect(pauseClosedReasonOf(pending(T10), AT)).toBe(PauseClosedReason.Expired);
    expect(pauseClosedReasonOf(pending(T9), AT)).toBe(PauseClosedReason.Expired);
  });

  it("a pause that is not pending says why it closed, at any time", () => {
    expect(
      pauseClosedReasonOf(closed({ resolution: PauseResolution.Withdrawn, expiresAt: T11 }), AT),
    ).toBe(PauseClosedReason.Withdrawn);
  });

  it("when it closed: the deadline for an expiry, else the time it was resolved — the first close's when one followed", () => {
    expect(
      closedAtOf(closed({ resolution: PauseResolution.Expired, expiresAt: T9, resolvedAt: T10 })),
    ).toBe(T9);
    expect(
      closedAtOf(
        closed({ resolution: PauseResolution.DecidedOnExpiry, expiresAt: T9, resolvedAt: T10 }),
      ),
    ).toBe(T9);
    expect(
      closedAtOf(closed({ resolution: PauseResolution.Cancelled, expiresAt: T9, resolvedAt: T10 })),
    ).toBe(T10);
    expect(
      closedAtOf(
        closed({
          resolution: PauseResolution.Cancelled,
          resolvedAt: T11,
          expiresAt: T9,
          closedFirst: { resolution: PauseResolution.Replied, resolvedAt: T10 },
        }),
      ),
    ).toBe(T10);
    expect(
      closedAtOf(
        closed({
          resolution: PauseResolution.Cancelled,
          resolvedAt: T11,
          expiresAt: T9,
          closedFirst: { resolution: PauseResolution.DecidedOnExpiry, resolvedAt: T10 },
        }),
      ),
    ).toBe(T9);
    expect(closedAtOf(pauseOf("p-1"))).toBeUndefined();
  });
});

describe("#1356: the scans of the pause stores", () => {
  it("take a limit that is a whole number from 1 to 1000, and say what it must be", () => {
    for (const limit of [1, 2, 999, MAX_SCAN_LIMIT])
      expect(() => {
        assertScanLimit(limit);
      }).not.toThrow();
    for (const limit of [0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        assertScanLimit(limit);
      }).toThrow(RangeError);
      expect(() => {
        assertScanLimit(limit);
      }).toThrow(`a pause scan's limit is a whole number from 1 to 1000, not ${String(limit)}`);
    }
  });

  it("a filter names at least one status", () => {
    expect(() => {
      assertPauseFilter({ statuses: [PauseStatus.Pending] });
    }).not.toThrow();
    expect(() => {
      assertPauseFilter({ statuses: [] });
    }).toThrow(TypeError);
    expect(() => {
      assertPauseFilter({ statuses: [] });
    }).toThrow("a pause filter names at least one status");
  });

  it("a pause is what a filter selects by its status, its channel and its deadline, each only when asked", () => {
    const pause: PauseRecord = { ...pauseOf("p-1"), channel: "refund", expiresAt: T10 };
    const filter = (rest: Partial<PauseFilter>): PauseFilter => ({
      statuses: [PauseStatus.Pending],
      ...rest,
    });

    expect(matchesFilter(pause, filter({}))).toBe(true);
    expect(matchesFilter(pause, { statuses: [PauseStatus.Taken] })).toBe(false);
    expect(matchesFilter(pause, filter({ channel: "refund" }))).toBe(true);
    expect(matchesFilter(pause, filter({ channel: "other" }))).toBe(false);
    expect(matchesFilter(pause, filter({ expiresBefore: new Date(T11) }))).toBe(true);
    expect(matchesFilter(pause, filter({ expiresBefore: AT }))).toBe(false);
    expect(matchesFilter(pause, filter({ expiresBefore: new Date(T9) }))).toBe(false);
    expect(
      matchesFilter(
        { ...pauseOf("p-2"), channel: "refund" },
        filter({ expiresBefore: new Date(T11) }),
      ),
    ).toBe(false);
  });

  it("order text by code unit", () => {
    expect([compareText("a", "b"), compareText("b", "a"), compareText("a", "a")]).toEqual([
      -1, 1, 0,
    ]);
    expect(compareText("B", "a")).toBe(-1);
    expect(compareText("", "a")).toBe(-1);
  });

  it("a cursor is the sequence it continues after, and none is the start", () => {
    expect(cursorOfSeq(42)).toBe("42");
    expect(seqOfCursor(undefined)).toBe(0);
    expect(seqOfCursor("0")).toBe(0);
    expect(seqOfCursor("42")).toBe(42);
    expect(seqOfCursor(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a text that is no cursor is refused, shown as text: a sign, a space, a fraction, a number too large", () => {
    for (const cursor of [
      "",
      "-1",
      "+1",
      " 1",
      "1 ",
      "1.5",
      "1e3",
      "abc",
      "9007199254740993",
      "0x10",
      "1\n2",
    ])
      expect(() => seqOfCursor(cursor)).toThrow(
        `${JSON.stringify(cursor)} is not a pause page cursor`,
      );
  });

  it("a page is the first `limit`, and names where the next one goes on only when more follow", () => {
    const ordered = [1, 2, 3].map((seq) => ({ pause: pauseOf(`p-${String(seq)}`), seq: seq * 10 }));

    expect(pageOf(ordered, 3)).toStrictEqual({ pauses: ordered.map((one) => one.pause) });
    expect(pageOf(ordered, 2)).toStrictEqual({
      pauses: [ordered[0]?.pause, ordered[1]?.pause],
      next: "20",
    });
    expect(pageOf([], 2)).toStrictEqual({ pauses: [] });
  });
});

describe("#1356: the log entry of a pause's answer (#267 S107)", () => {
  const answered: PauseRecord = {
    ...pauseOf("p-1"),
    status: PauseStatus.Taken,
    answer: { decision: { approved: true }, answeredBy: "manager-1" },
    resolution: PauseResolution.Replied,
    resolvedAt: T10,
  };

  it("keeps who answered and what, and where and when", () => {
    const entry = answerRecordOf(answered, PauseResolution.Replied);

    expect(entry).toMatchObject({
      executionId: "run-1",
      answerer: PauseAnswerer.Channel,
      answeredBy: "manager-1",
      responder: "manager-1",
      resolution: PauseResolution.Replied,
      role: "refund-approval-channel",
      askedAt: "2026-01-05T09:00:00.000Z",
      resolvedAt: T10,
      decision: { approved: true },
      asked: answered.ask,
    });
    expect(entry.step).toMatchObject({
      nodeId: "clerk-agent",
      visitNumber: 1,
      idempotencyKey: "run-1:clerk-agent:1:call-1",
      callId: "call-1",
      copyNumber: 1,
      validationAttempts: 0,
    });
  });

  it("names no pause when the channel answers, and the step's own key and attempts when a pause was reassigned", () => {
    const channels = { ...answered, answerer: PauseAnswerer.Channel };
    const owner = { ...answered, answerer: PauseAnswerer.ThreadOwner };

    expect(answerRecordOf(channels, PauseResolution.Replied).pauseId).toBeUndefined();
    expect(answerRecordOf(owner, PauseResolution.Replied).pauseId).toBe("p-1");
    expect(
      answerRecordOf(
        { ...answered, stepKey: "run-1:s:1~r2", reassignedFrom: "p-0", validationAttempts: 3 },
        PauseResolution.Replied,
      ).step,
    ).toMatchObject({ idempotencyKey: "run-1:s:1", validationAttempts: 3 });
  });

  it("a pause closed without an answer keeps none of it: not who, not what", () => {
    for (const resolution of [
      PauseResolution.Withdrawn,
      PauseResolution.Cancelled,
      PauseResolution.TreeEnded,
      PauseResolution.Expired,
      PauseResolution.Reassigned,
    ]) {
      const entry = answerRecordOf(answered, resolution);

      expect(entry.answeredBy).toBeUndefined();
      expect(entry.decision).toBeUndefined();
      expect(entry.resolution).toBe(resolution);
    }
    for (const resolution of [
      PauseResolution.Decided,
      PauseResolution.Replied,
      PauseResolution.DecidedOnExpiry,
    ])
      expect(answerRecordOf(answered, resolution).decision).toStrictEqual({ approved: true });
  });

  it("an answer no step took keeps the answer and says it was not taken, as the record closed it", () => {
    const untaken = {
      ...answered,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.TreeEnded,
    };

    expect(notTakenRecordOf(untaken)).toMatchObject({
      isTaken: false,
      resolution: PauseResolution.TreeEnded,
      answeredBy: "manager-1",
      decision: { approved: true },
    });
    expect(notTakenRecordOf({ ...untaken, resolution: undefined }).resolution).toBe(
      PauseResolution.Cancelled,
    );
  });

  it("a question has no call, an approval has its", () => {
    expect(callIdOfPause(answered)).toBe("call-1");
    expect(callIdOfPause(questionPauseOf("p-q"))).toBeUndefined();
  });
});

describe("#1356: a pause record's own rules", () => {
  it("no one is the recipient of a transition that tells nobody", () => {
    expect(NO_RECIPIENTS).toStrictEqual({ listeners: [] });
  });

  it("a question's ask is an object: null, a list and a text are refused, shown as they are", () => {
    expect(questionAskOf({ text: "ok" })).toStrictEqual({ text: "ok" });
    for (const ask of [null, ["x"], "text", 5, undefined])
      expect(() => questionAskOf(ask)).toThrow(
        `a question's ask is an object (the role's ask DTO), not ${JSON.stringify(ask)}`,
      );
  });

  it("who may answer is the answerer, else the 0.1.0 spelling of it, else an error", () => {
    expect(pauseAnswererOf({ answerer: PauseAnswerer.Channel })).toBe(PauseAnswerer.Channel);
    expect(pauseAnswererOf({ answeredBy: PauseAnswerer.ThreadOwner })).toBe(
      PauseAnswerer.ThreadOwner,
    );
    expect(
      pauseAnswererOf({ answerer: PauseAnswerer.ThreadOwner, answeredBy: PauseAnswerer.Channel }),
    ).toBe(PauseAnswerer.ThreadOwner);
    expect(() => pauseAnswererOf({})).toThrow(TypeError);
    expect(() => pauseAnswererOf({})).toThrow("a pause record names who may answer it");
  });
});

describe("#1356: the receivers of a notice", () => {
  it("the channel and the listeners, once each; `opened` goes to the listeners only", () => {
    const recipients = { channel: "refund", listeners: ["metrics", "audit", "metrics"] };

    expect(recipientKeysOf(recipients, PauseNoticeKind.Closed)).toEqual([
      "channel:refund",
      "listener:metrics",
      "listener:audit",
    ]);
    expect(recipientKeysOf(recipients, PauseNoticeKind.Opened)).toEqual([
      "listener:metrics",
      "listener:audit",
    ]);
    expect(recipientKeysOf({ listeners: ["metrics"] }, PauseNoticeKind.Closed)).toEqual([
      "listener:metrics",
    ]);
    expect(recipientKeysOf(NO_RECIPIENTS, PauseNoticeKind.Closed)).toEqual([]);
  });
});

describe("#1356: the answer log written before a closed pause is removed (#939)", () => {
  /** A log that remembers what it was asked to write. */
  function logOf() {
    const saved: unknown[][] = [];
    const notTaken: unknown[][] = [];
    const log: PauseAnswerLog = {
      savePauseAnswer: (...args: unknown[]) => {
        saved.push(args);
        return Promise.resolve();
      },
      markPauseAnswerNotTaken: (...args: unknown[]) => {
        notTaken.push(args);
        return Promise.resolve();
      },
      findPauseAnswersByTenantIdAndRootExecutionId: () => Promise.resolve([]),
    };
    return { log, saved, notTaken };
  }

  const closed = (fields: Partial<PauseRecord>): PauseRecord => ({
    ...pauseOf(`p-${String(Math.random())}`),
    status: PauseStatus.Taken,
    resolvedAt: T9,
    ...fields,
  });
  const answer = { decision: { approved: true }, answeredBy: "manager-1" };

  /** The log entries the removal wrote for `pauses`, and what it removed. */
  async function removed(pauses: PauseRecord[]) {
    const { log, saved, notTaken } = logOf();
    const deleteByResolvedAtBefore = vi.fn(() => Promise.resolve());
    const findClosedByResolvedAtBefore = vi.fn((_cutoff: Date, _limit: number, after?: string) =>
      Promise.resolve(after === undefined ? { pauses, next: undefined } : { pauses: [] }),
    );
    await removeClosedPauses({ findClosedByResolvedAtBefore, deleteByResolvedAtBefore }, log, AT);
    return { saved, notTaken, deleteByResolvedAtBefore, findClosedByResolvedAtBefore };
  }

  it("writes how each was resolved, then removes them once", async () => {
    const { saved, notTaken, deleteByResolvedAtBefore, findClosedByResolvedAtBefore } =
      await removed([
        closed({ resolution: PauseResolution.Replied, answer }),
        closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.Withdrawn }),
        closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.Expired }),
      ]);

    expect(saved.map(([, , entry]) => (entry as { resolution: string }).resolution)).toEqual([
      PauseResolution.Replied,
      PauseResolution.Withdrawn,
      PauseResolution.Expired,
    ]);
    expect(notTaken).toEqual([]);
    expect(deleteByResolvedAtBefore).toHaveBeenCalledTimes(1);
    expect(deleteByResolvedAtBefore).toHaveBeenCalledWith(AT);
    expect(findClosedByResolvedAtBefore).toHaveBeenCalledWith(AT, REPAIR_PAGE, undefined);
  });

  it("a cancelled pause that kept an answer is written as an answer no step took", async () => {
    const { saved, notTaken } = await removed([
      closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.TreeEnded, answer }),
      closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.Cancelled, answer }),
    ]);

    expect(saved).toEqual([]);
    expect(notTaken).toHaveLength(2);
  });

  it("a cancelled pause with no answer, one closed another way that kept its answer, or an answered one that was taken, is written as it resolved", async () => {
    const { saved, notTaken } = await removed([
      closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.TreeEnded }),
      closed({ status: PauseStatus.Taken, resolution: PauseResolution.TreeEnded, answer }),
      closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.Withdrawn, answer }),
      closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.Expired, answer }),
    ]);

    expect(notTaken).toEqual([]);
    expect(saved).toHaveLength(4);
  });

  it("a reassigned pause writes nothing: its replacement answers for the step", async () => {
    const { saved, notTaken, deleteByResolvedAtBefore } = await removed([
      closed({ status: PauseStatus.Cancelled, resolution: PauseResolution.Reassigned }),
    ]);

    expect(saved).toEqual([]);
    expect(notTaken).toEqual([]);
    expect(deleteByResolvedAtBefore).toHaveBeenCalledTimes(1);
  });

  it("a pause replied with no answer kept is written as replied", async () => {
    const { saved } = await removed([closed({ resolution: PauseResolution.Replied })]);

    expect(saved.map(([, , entry]) => (entry as { resolution: string }).resolution)).toEqual([
      PauseResolution.Replied,
    ]);
  });

  it("a record written before resolutions is written by its status: cancelled, or else replied", async () => {
    const { saved } = await removed([
      closed({ status: PauseStatus.Cancelled }),
      closed({ status: PauseStatus.Taken }),
    ]);

    expect(saved.map(([, , entry]) => (entry as { resolution: string }).resolution)).toEqual([
      PauseResolution.Cancelled,
      PauseResolution.Replied,
    ]);
  });

  it("a channel's own decision of a reassigned send, stored as replied, is written as decided", async () => {
    const { saved } = await removed([
      closed({ resolution: PauseResolution.Replied, answer: { ...answer, byChannel: true } }),
      closed({ resolution: PauseResolution.Replied, answer }),
      closed({
        resolution: PauseResolution.Cancelled,
        status: PauseStatus.Taken,
        answer: { ...answer, byChannel: true },
      }),
    ]);

    expect(saved.map(([, , entry]) => (entry as { resolution: string }).resolution)).toEqual([
      PauseResolution.Decided,
      PauseResolution.Replied,
      PauseResolution.Cancelled,
    ]);
  });

  it("reads the listing page by page to its end before it removes anything; a listing that fails removes nothing", async () => {
    const { log } = logOf();
    const pages = [
      { pauses: [closed({ resolution: PauseResolution.Replied, answer })], next: "10" },
      { pauses: [closed({ resolution: PauseResolution.Replied, answer })], next: "20" },
      { pauses: [closed({ resolution: PauseResolution.Replied, answer })] },
    ];
    const order: string[] = [];
    const afters: (string | undefined)[] = [];
    const reads = vi.fn((_cutoff: Date, _limit: number, after?: string) => {
      afters.push(after);
      order.push("read");
      return Promise.resolve(pages[afters.length - 1] ?? { pauses: [] });
    });
    const remove = vi.fn(() => {
      order.push("remove");
      return Promise.resolve();
    });

    await removeClosedPauses(
      { findClosedByResolvedAtBefore: reads, deleteByResolvedAtBefore: remove },
      log,
      AT,
    );

    expect(afters).toEqual([undefined, "10", "20"]);
    expect(order).toEqual(["read", "read", "read", "remove"]);

    const failing = vi.fn(() => Promise.reject(new Error("store down")));
    const none = vi.fn(() => Promise.resolve());
    await expect(
      removeClosedPauses(
        { findClosedByResolvedAtBefore: failing, deleteByResolvedAtBefore: none },
        log,
        AT,
      ),
    ).rejects.toThrow("store down");
    expect(none).not.toHaveBeenCalled();
  });
});
