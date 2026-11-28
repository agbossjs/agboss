/**
 * #1307 (G3), #1356 (shard `pauses`) — an Invalid Date is refused where a store would keep it, naming the field
 * and the record (`StoreError.UnreadableRecord`, never the value): each transition's `at` and facts, a timeout change's
 * and a reassignment's deadlines, a pause answer's times and a paused run's, and the way stored texts of instants are read.
 */
import { describe, expect, it } from "vitest";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import {
  instantOfOptionalText,
  instantOfText,
  isCanonicalInstantText,
  isValidInstant,
} from "../../src/infrastructure/instants.js";
import { InMemoryPauseBook } from "../../src/infrastructure/in-memory-pause-book.js";
import { assertPauseAnswerInstants } from "../../src/infrastructure/pause-answer-instants.js";
import { assertPausedRunInstants } from "../../src/infrastructure/paused-run-instants.js";
import { reassignChange } from "../../src/infrastructure/pause-reassign-transition.js";
import { timeoutChange } from "../../src/infrastructure/pause-timeout-change.js";
import {
  cancelChange,
  closeUntakenChange,
  decideChange,
  expireChange,
  onceNotices,
  remindChange,
  resolveChange,
} from "../../src/infrastructure/pause-transitions.js";
import { PauseNoticeKind } from "../../src/infrastructure/pause-notices.js";
import { PauseResolution } from "../../src/infrastructure/pause-record.js";
import {
  APPROVED_BY_MANAGER,
  pauseOf,
  RECIPIENTS,
} from "../../src/testing/contracts/paused-execution-data.js";

const BAD = new Date(Number.NaN);
const GOOD = new Date("2026-01-05T10:00:00.000Z");
const PAUSE = pauseOf("p-1");

const refusal = (field: string, record = "pause"): string =>
  `an Invalid Date was given for ${field} of a ${record}: nothing was written (the fields name no stored row; check the clock or the time that was passed)`;

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

const refusedWith = (run: () => unknown, field: string, record?: string) => {
  const error = caught(run);
  expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
  expect(error).toHaveProperty("message", refusal(field, record));
  expect(error).toHaveProperty("isInvalidDate", true);
};

describe("#1307: the transitions of a pause refuse an Invalid Date, naming it", () => {
  const seen = { trailLength: 1, isSent: false } as never;

  it.each([
    ["resolveChange", () => resolveChange(PAUSE, APPROVED_BY_MANAGER, BAD, RECIPIENTS)],
    ["decideChange", () => decideChange(PAUSE, APPROVED_BY_MANAGER, BAD, seen)],
    ["cancelChange", () => cancelChange(PAUSE, PauseResolution.Withdrawn, BAD, RECIPIENTS)],
    ["expireChange", () => expireChange(PAUSE, {}, BAD, RECIPIENTS)],
    [
      "closeUntakenChange",
      () => closeUntakenChange(PAUSE, PauseResolution.TreeEnded, BAD, RECIPIENTS),
    ],
    ["remindChange", () => remindChange(PAUSE, BAD, RECIPIENTS)],
    ["a notice's time", () => onceNotices(PAUSE, PauseNoticeKind.Closed, {}, BAD, RECIPIENTS)],
  ])("%s: the time it is made at", (_name, run) => {
    refusedWith(run, "at");
  });

  it("a notice's facts: when it closed, the deadline and the deadline before", () => {
    const notice = (facts: object) => () =>
      onceNotices(PAUSE, PauseNoticeKind.Closed, facts, GOOD, RECIPIENTS);

    refusedWith(notice({ closedAt: BAD }), "closedAt");
    refusedWith(notice({ expiresAt: BAD }), "expiresAt");
    refusedWith(notice({ previousExpiresAt: BAD }), "previousExpiresAt");
    expect(
      caught(notice({ closedAt: GOOD, expiresAt: GOOD, previousExpiresAt: GOOD })),
    ).toBeUndefined();
  });

  it("a timeout change: its time, the deadline and the reminder", () => {
    const change = (changes: object) => () =>
      timeoutChange(PAUSE, { seen, ...changes }, GOOD, RECIPIENTS);

    refusedWith(() => timeoutChange(PAUSE, { seen }, BAD, RECIPIENTS), "at");
    refusedWith(change({ expiresAt: BAD }), "expiresAt");
    refusedWith(change({ remindAt: BAD }), "remindAt");
  });

  it("a reassignment: its time, an expiry's deadline and reminder, an operator's deadline and reminder", () => {
    const change = (changes: object) => () =>
      reassignChange(PAUSE, { seen, ...changes }, new Set(), GOOD, RECIPIENTS);

    refusedWith(() => reassignChange(PAUSE, { seen }, new Set(), BAD, RECIPIENTS), "at");
    refusedWith(change({ due: { expiresAt: BAD } }), "due.expiresAt");
    refusedWith(change({ due: { remindAt: BAD } }), "due.remindAt");
    refusedWith(change({ timeout: { expiresAt: BAD } }), "timeout.expiresAt");
    refusedWith(change({ timeout: { remindAt: BAD } }), "timeout.remindAt");
  });
});

describe("#1307: a pause answer and a paused run refuse an Invalid Date, naming it", () => {
  const answer = (changes: object) =>
    ({
      askedAt: GOOD,
      resolvedAt: GOOD,
      trail: [{ at: GOOD }, { at: GOOD, expiresAt: GOOD }],
      ...changes,
    }) as never;

  it("a pause answer: when it was asked and resolved, each entry's time and deadline", () => {
    refusedWith(
      () => {
        assertPauseAnswerInstants(answer({ askedAt: BAD }));
      },
      "askedAt",
      "pause answer",
    );
    refusedWith(
      () => {
        assertPauseAnswerInstants(answer({ resolvedAt: BAD }));
      },
      "resolvedAt",
      "pause answer",
    );
    refusedWith(
      () => {
        assertPauseAnswerInstants(answer({ trail: [{ at: GOOD }, { at: BAD }] }));
      },
      "trail[1].at",
      "pause answer",
    );
    refusedWith(
      () => {
        assertPauseAnswerInstants(answer({ trail: [{ at: GOOD, expiresAt: BAD }] }));
      },
      "trail[0].expiresAt",
      "pause answer",
    );
    expect(
      caught(() => {
        assertPauseAnswerInstants(answer({}));
      }),
    ).toBeUndefined();
  });

  it("a paused run: each pending pause's deadline", () => {
    const run = (...deadlines: (Date | undefined)[]) =>
      ({ run: { pending: deadlines.map((expiresAt) => ({ expiresAt })) } }) as never;

    refusedWith(
      () => {
        assertPausedRunInstants(run(GOOD, BAD));
      },
      "pending[1].expiresAt",
      "paused run",
    );
    expect(
      caught(() => {
        assertPausedRunInstants(run(GOOD, undefined));
      }),
    ).toBeUndefined();
  });
});

describe("#1307: the texts of stored instants", () => {
  it("one is read only in the canonical spelling, anchored at its end, the pause named unless another record is", () => {
    expect(instantOfText("2026-01-05T10:00:00.000Z", "expires_at")).toEqual(GOOD);
    for (const text of ["2026-01-05T10:00:00.000Zjunk", "2026-01-05T10:00:00Z", ""]) {
      const error = caught(() => instantOfText(text, "expires_at"));
      expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
      expect(error).toHaveProperty(
        "message",
        "a stored pause is not readable: the field(s) expires_at missing or not what the framework wrote",
      );
    }
    expect(caught(() => instantOfText("x", "expires_at", "pause mailbox"))).toHaveProperty(
      "message",
      "a stored pause mailbox is not readable: the field(s) expires_at missing or not what the framework wrote",
    );
  });

  it("only a four-digit year is a canonical text: a year past 9999 or before 0000 spells with a sign and six digits", () => {
    const far = new Date("+010000-01-01T00:00:00.000Z");

    expect(isValidInstant(far)).toBe(false);
    expect(isValidInstant(GOOD)).toBe(true);
    expect(isCanonicalInstantText(far.toISOString())).toBe(false);
    expect(isCanonicalInstantText("2026-01-05T10:00:00.000Z")).toBe(true);
    expect(isCanonicalInstantText("2026-01-05T10:00:00.000+00:00")).toBe(false);
  });

  it("an optional one is none for none, null or undefined, else read the same way", () => {
    expect(instantOfOptionalText(undefined, "remind_at")).toBeUndefined();
    expect(instantOfOptionalText(null, "remind_at")).toBeUndefined();
    expect(instantOfOptionalText("2026-01-05T10:00:00.000Z", "remind_at")).toEqual(GOOD);
    expect(caught(() => instantOfOptionalText("x", "remind_at"))).toHaveProperty(
      "message",
      "a stored pause is not readable: the field(s) remind_at missing or not what the framework wrote",
    );
    expect(caught(() => instantOfOptionalText("x", "remind_at", "pause mailbox"))).toHaveProperty(
      "message",
      "a stored pause mailbox is not readable: the field(s) remind_at missing or not what the framework wrote",
    );
  });
});

describe("#1307: the in-memory book refuses an Invalid Date, naming it and the record", () => {
  const book = () => new InMemoryPauseBook();
  const claim = {} as never;

  it.each([
    ["claim", "at", (b: InMemoryPauseBook) => b.claim(BAD, 1, 1, ["r"])],
    ["ack", "at", (b: InMemoryPauseBook) => b.ack(claim, BAD)],
    ["renew", "at", (b: InMemoryPauseBook) => b.renew(claim, BAD, 1)],
    ["retry", "nextAttemptAt", (b: InMemoryPauseBook) => b.retry(claim, BAD, "p")],
    [
      "setAsideStale writtenBefore",
      "writtenBefore",
      (b: InMemoryPauseBook) => b.setAsideStale(BAD, GOOD, "p", 1),
    ],
    ["setAsideStale at", "at", (b: InMemoryPauseBook) => b.setAsideStale(GOOD, BAD, "p", 1)],
  ])("%s", (_name, field, run) => {
    refusedWith(() => run(book()), field, "pause mailbox");
  });

  it("a change whose record, or whose inserted replacement, holds one is refused before anything is applied", () => {
    const b = book();
    b.insert(PAUSE);

    refusedWith(
      () =>
        b.change(PAUSE.tenantId, PAUSE.pauseId, (current) => ({
          pause: { ...current, askedAt: BAD },
          notices: [],
        })),
      "askedAt",
    );
    refusedWith(
      () =>
        b.change(PAUSE.tenantId, PAUSE.pauseId, (current) => ({
          pause: { ...current, isSent: true },
          notices: [],
          inserted: { ...pauseOf("p-2", "key-2"), expiresAt: BAD },
        })),
      "expiresAt",
    );
    expect(b.find(PAUSE.tenantId, "p-2")).toBeUndefined();
    expect(b.find(PAUSE.tenantId, PAUSE.pauseId)?.isSent).toBe(false);
    expect(b.find(PAUSE.tenantId, PAUSE.pauseId)?.askedAt).toEqual(PAUSE.askedAt);
    refusedWith(() => {
      b.insert({ ...PAUSE, pauseId: "p-3", askedAt: BAD });
    }, "askedAt");
  });
});
