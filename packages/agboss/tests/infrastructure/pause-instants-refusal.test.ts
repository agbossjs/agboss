/**
 * #1307 (G3, pauses shard) — an Invalid Date is refused where a store would keep it and where a rule
 * would compare it: `StoreError.UnreadableRecord` naming the field, never the value, before anything
 * is written; and the one notice a record owes with no time of its own is still written.
 */
import { describe, expect, it } from "vitest";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { assertValidInstant, isValidInstant } from "../../src/infrastructure/instants.js";
import { assertPauseAnswerInstants } from "../../src/infrastructure/pause-answer-instants.js";
import * as stores from "../../src/stores/index.js";
import { assertPauseInstants } from "../../src/infrastructure/pause-instants-valid.js";
import { PauseNoticeKind } from "../../src/infrastructure/pause-notices.js";
import { PauseResolution, PauseStatus } from "../../src/infrastructure/pause-record.js";
import { reassignChange } from "../../src/infrastructure/pause-reassign-transition.js";
import { seenOf } from "../../src/infrastructure/pause-seen.js";
import { timeoutChange } from "../../src/infrastructure/pause-timeout-change.js";
import {
  cancelChange,
  closeUntakenChange,
  decideChange,
  expireChange,
  markSentChange,
  onceNotices,
  remindChange,
  resolveChange,
} from "../../src/infrastructure/pause-transitions.js";
import {
  APPROVED_BY_MANAGER,
  DECIDED_ANSWER,
  expiringPauseOf,
  NINE,
  RECIPIENTS,
} from "../../src/testing/contracts/paused-execution-data.js";
import { preciseOf } from "../../src/testing/contracts/paused-execution-instants-data.js";
import { answerOf, STEP_KEY } from "../../src/testing/contracts/pause-answer-data.js";

const BAD = (): Date => new Date(Number.NaN);

/** The error `run` throws; fails the test when it returns. */
const thrownBy = (run: () => unknown): StoreError.UnreadableRecord => {
  try {
    run();
  } catch (error) {
    if (error instanceof StoreError.UnreadableRecord) return error;
    throw error;
  }
  throw new Error("nothing was thrown");
};

describe("assertValidInstant (#1307)", () => {
  it("accepts a Date of an instant and an absent time, refuses Invalid Date naming the field", () => {
    expect(isValidInstant(new Date(0))).toBe(true);
    expect(isValidInstant(BAD())).toBe(false);
    expect(() => {
      assertValidInstant(new Date(0), "askedAt");
      assertValidInstant(undefined, "askedAt");
    }).not.toThrow();

    const error = thrownBy(() => {
      assertValidInstant(BAD(), "askedAt");
    });

    expect(error.message).toBe(
      "an Invalid Date was given for askedAt of a pause: nothing was written (the fields name no stored row; check the clock or the time that was passed)",
    );
    expect(error.message).not.toContain("not readable");
    expect(error.message).not.toContain("NaN");
    expect(error.isInvalidDate).toBe(true);
    expect(
      thrownBy(() => {
        assertValidInstant(BAD(), "resolvedAt", "pause answer");
      }).message,
    ).toContain("of a pause answer: nothing was written");
  });
});

describe("assertPauseInstants (#1307)", () => {
  it("refuses an Invalid Date in each of the times of a pause, naming it", () => {
    const made = preciseOf("pause-a");
    const variants: Record<string, object> = {
      askedAt: { askedAt: BAD() },
      firstAskedAt: { firstAskedAt: BAD() },
      maxExpiresAt: { maxExpiresAt: BAD() },
      resolvedAt: { resolvedAt: BAD() },
      expiresAt: { expiresAt: BAD() },
      remindAt: { remindAt: BAD() },
      boundAt: { boundAt: BAD() },
      "closedFirst.resolvedAt": { closedFirst: { resolution: "replied", resolvedAt: BAD() } },
      "trail[1].at": { trail: [...made.trail, { ...made.trail[0], at: BAD() }] },
      "trail[0].expiresAt": { trail: [{ ...made.trail[0], expiresAt: BAD() }] },
    };

    expect(() => {
      assertPauseInstants(made);
    }).not.toThrow();
    for (const [field, changed] of Object.entries(variants))
      expect(
        thrownBy(() => {
          assertPauseInstants({ ...made, ...changed });
        }).message,
        field,
      ).toContain(`an Invalid Date was given for ${field} of a`);
  });
});

describe("assertPauseAnswerInstants (#1307)", () => {
  it("is exported from the stores entry, the very function the answer log calls", () => {
    expect(stores.assertPauseAnswerInstants).toBe(assertPauseAnswerInstants);
  });

  it("refuses an Invalid Date in the times of a pause answer, naming it", () => {
    const good = answerOf("manager-17", true, STEP_KEY, new Date(1));
    const variants: Record<string, object> = {
      askedAt: { askedAt: BAD() },
      resolvedAt: { resolvedAt: BAD() },
      "trail[0].at": { trail: [{ ...good.trail[0], at: BAD() }] },
      "trail[0].expiresAt": { trail: [{ ...good.trail[0], expiresAt: BAD() }] },
    };

    expect(() => {
      assertPauseAnswerInstants({ ...good, resolvedAt: new Date(2) });
    }).not.toThrow();
    for (const [field, changed] of Object.entries(variants))
      expect(
        thrownBy(() => {
          assertPauseAnswerInstants({ ...good, ...changed });
        }).message,
        field,
      ).toContain(`an Invalid Date was given for ${field} of a`);
  });
});

describe("the transitions refuse an Invalid Date (#1307)", () => {
  const sent = { ...expiringPauseOf("pause-a"), isSent: true };
  const resolved = {
    ...sent,
    status: PauseStatus.Resolved,
    answer: APPROVED_BY_MANAGER,
    resolution: PauseResolution.Replied,
    resolvedAt: NINE,
  };
  const seen = seenOf(sent);

  const calls: Record<string, () => unknown> = {
    resolveChange: () => resolveChange(sent, APPROVED_BY_MANAGER, BAD(), RECIPIENTS),
    decideChange: () => decideChange(sent, DECIDED_ANSWER, BAD(), seen),
    cancelChange: () => cancelChange(sent, PauseResolution.Cancelled, BAD(), RECIPIENTS),
    expireChange: () => expireChange(sent, { problem: undefined }, BAD(), RECIPIENTS),
    closeUntakenChange: () =>
      closeUntakenChange(resolved, PauseResolution.Cancelled, BAD(), RECIPIENTS),
    remindChange: () => remindChange(sent, BAD(), RECIPIENTS),
    "timeoutChange at": () =>
      timeoutChange(sent, { seen, previousExpiresAt: sent.expiresAt }, BAD(), RECIPIENTS),
    "timeoutChange expiresAt": () =>
      timeoutChange(
        sent,
        { seen, expiresAt: BAD(), previousExpiresAt: sent.expiresAt },
        NINE,
        RECIPIENTS,
      ),
    "timeoutChange remindAt": () =>
      timeoutChange(
        sent,
        { seen, remindAt: BAD(), previousExpiresAt: sent.expiresAt },
        NINE,
        RECIPIENTS,
      ),
    "reassignChange at": () =>
      reassignChange(sent, { seen, assignees: ["x"] }, new Set(), BAD(), RECIPIENTS),
    "reassignChange due": () =>
      reassignChange(sent, { seen, due: { expiresAt: BAD() } }, new Set(), NINE, RECIPIENTS),
    "reassignChange timeout remindAt": () =>
      reassignChange(sent, { seen, timeout: { remindAt: BAD() } }, new Set(), NINE, RECIPIENTS),
    "onceNotices at": () => onceNotices(sent, PauseNoticeKind.Expiring, {}, BAD(), RECIPIENTS),
    "onceNotices expiresAt": () =>
      onceNotices(sent, PauseNoticeKind.Expiring, { expiresAt: BAD() }, NINE, RECIPIENTS),
    "onceNotices closedAt": () =>
      onceNotices(sent, PauseNoticeKind.Closed, { closedAt: BAD() }, NINE, RECIPIENTS),
    "onceNotices previousExpiresAt": () =>
      onceNotices(
        sent,
        PauseNoticeKind.TimeoutChanged,
        { previousExpiresAt: BAD() },
        NINE,
        RECIPIENTS,
      ),
  };

  for (const [name, call] of Object.entries(calls))
    it(`${name}: an Invalid Date is a StoreError.UnreadableRecord, not "the condition does not hold"`, () => {
      expect(thrownBy(call)).toBeInstanceOf(StoreError.UnreadableRecord);
    });

  it("a valid time is applied as before", () => {
    expect(resolveChange(sent, APPROVED_BY_MANAGER, NINE, RECIPIENTS)?.pause.status).toBe(
      PauseStatus.Resolved,
    );
  });
});

describe("markSentChange keeps the answerNotTaken of an untaken close with no resolvedAt (#1307)", () => {
  it("writes it at the epoch, as before the dates were Dates: it is never dropped", () => {
    const closed = {
      ...expiringPauseOf("pause-a"),
      isSent: false,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Cancelled,
      answer: APPROVED_BY_MANAGER,
    };

    const sent = markSentChange(closed, RECIPIENTS);

    const untaken = sent.notices.filter(
      ({ notice }) => notice.kind === PauseNoticeKind.AnswerNotTaken,
    );
    expect(untaken.length).toBeGreaterThan(0);
    for (const { at, notice } of untaken) {
      expect(at.getTime()).toBe(0);
      expect(notice.closedAt?.getTime()).toBe(0);
    }
  });

  it("uses the record's own resolvedAt when it has one", () => {
    const closed = {
      ...expiringPauseOf("pause-a"),
      isSent: false,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.TreeEnded,
      answer: APPROVED_BY_MANAGER,
      resolvedAt: NINE,
    };

    const untaken = markSentChange(closed, RECIPIENTS).notices.filter(
      ({ notice }) => notice.kind === PauseNoticeKind.AnswerNotTaken,
    );

    expect(untaken.length).toBeGreaterThan(0);
    for (const { at } of untaken) expect(at.getTime()).toBe(NINE.getTime());
  });

  it("gives each notice an epoch Date of its own: a setTime on one moves no other", () => {
    const closed = {
      ...expiringPauseOf("pause-a"),
      isSent: false,
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Cancelled,
      answer: APPROVED_BY_MANAGER,
    };
    const first = markSentChange(closed, RECIPIENTS).notices.filter(
      ({ notice }) => notice.kind === PauseNoticeKind.AnswerNotTaken,
    );
    expect(first.length).toBeGreaterThan(1);
    for (const planned of first) {
      planned.at.setTime(5);
      planned.notice.writtenAt.setTime(6);
      planned.notice.closedAt?.setTime(7);
    }

    const second = markSentChange(closed, RECIPIENTS).notices.filter(
      ({ notice }) => notice.kind === PauseNoticeKind.AnswerNotTaken,
    );
    for (const { at, notice } of second) {
      expect(at.getTime()).toBe(0);
      expect(notice.writtenAt.getTime()).toBe(0);
      expect(notice.closedAt?.getTime()).toBe(0);
    }
    const [one, other] = second;
    expect(one?.at).not.toBe(other?.at);
    expect(one?.notice.writtenAt).not.toBe(other?.notice.writtenAt);
  });
});
