/**
 * #1366: the paused-execution contract's deadline cases (`paused-execution-deadline.cases.ts`, #910)
 * and extension race cases (`paused-execution-extend-race.cases.ts`, #1099, #1148) judge a store by
 * what it answers and keeps: each passes on the sound in-memory store — also when one instance is
 * slower than the other, so the other's call is first — and FAILS (with an assertion, never a crash)
 * on a store that breaks the rule the case names: an answer taken at or after the deadline, a
 * refused call that wrote, a closer that answers a wrong record, an extension that skips the
 * compare-and-set of the deadline read, the later-than check, the open check or the deadline's own
 * time.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import type {
  PauseDeadlineChange,
  PauseRecipients,
} from "../../../src/infrastructure/pause-notices.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PauseExpiry,
  type PauseRecord,
} from "../../../src/infrastructure/pause-record.js";
import {
  cancelChange,
  expireChange,
  extendChange,
  resolveChange,
  type PauseChange,
} from "../../../src/infrastructure/pause-transitions.js";
import type { ContractCase } from "../../../src/testing/contracts/define.js";
import { DEADLINE_CASES } from "../../../src/testing/contracts/paused-execution-deadline.cases.js";
import { EXTEND_RACE_CASES } from "../../../src/testing/contracts/paused-execution-extend-race.cases.js";
import type { PausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";

type Who = "first" | "second";
type Case = ContractCase<PausedExecutionRepository>;
type Op = "resolve" | "cancel" | "expire" | "extend";
/** A planned change that is answered but stored nowhere (`unstored`), or stored but answered nothing (`hidden`). */
type Planned = PauseChange & { readonly unstored?: boolean; readonly hidden?: boolean };

const EPOCH = new Date(0);
const FROM = "2026-01-05T10:00:00.000Z";
const LATER = "2026-01-05T12:00:00.000Z";
const EVEN_LATER = "2026-01-05T15:00:00.000Z";
const HOUR = 3_600_000;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));
const shifted = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

interface Tweaks {
  /** This instance's every call waits a moment first: the other instance's call is first. */
  readonly slow?: Who;
  /** This instance's first call waits a moment first (a cold connection). */
  readonly cold?: Who;
  /** Replaces the planned change of a resolve. */
  readonly resolve?: (
    pause: PauseRecord,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ) => Planned | undefined;
  /** Replaces the planned change of a cancel. */
  readonly cancel?: (
    pause: PauseRecord,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ) => Planned | undefined;
  /** Replaces the planned change of an expiry. */
  readonly expire?: (
    pause: PauseRecord,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ) => Planned | undefined;
  /** Replaces the planned change of an extension. */
  readonly extend?: (
    pause: PauseRecord,
    change: PauseDeadlineChange,
    at: Date,
    recipients: PauseRecipients,
  ) => Planned | undefined;
  /** What the call answers when the change applied (the record stays as stored). */
  readonly answers?: Partial<
    Record<Op, (answered: PauseRecord, before: PauseRecord) => PauseRecord | undefined>
  >;
  /** A pause is found by the first characters of its step key only. */
  readonly collideKeys?: boolean;
  /** What a lookup answers. */
  readonly found?: (found: PauseRecord | undefined) => PauseRecord | undefined;
}

class Instance extends InMemoryPausedExecutionRepository {
  #isWarm = false;

  constructor(
    readonly who: Who,
    readonly tweaks: Tweaks,
    sharing?: Instance,
  ) {
    super();
    if (sharing !== undefined) Reflect.set(this, "book", Reflect.get(sharing, "book"));
  }

  async #wait(): Promise<void> {
    if (this.tweaks.slow === this.who) await tick();
    if (this.tweaks.cold === this.who && !this.#isWarm) await tick();
    this.#isWarm = true;
  }

  async #change(
    op: Op,
    tenantId: string,
    pauseId: string,
    plan: (pause: PauseRecord) => Planned | undefined,
  ): Promise<PauseRecord | undefined> {
    await this.#wait();
    const before = this.book.find(tenantId, pauseId);
    if (before === undefined) return undefined;
    const planned = plan(before);
    if (planned === undefined) return undefined;
    if (planned.unstored === true) return planned.pause;
    const stored = this.book.change(tenantId, pauseId, () => planned);
    if (planned.hidden === true) return undefined;
    const answers = this.tweaks.answers?.[op];
    return answers === undefined || stored === undefined ? stored : answers(stored, before);
  }

  override async findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    if (this.tweaks.collideKeys !== true) return super.findOrCreateByStepKey(pause);
    const same = this.pauses().find(
      (one) =>
        one.tenantId === pause.tenantId &&
        one.rootExecutionId === pause.rootExecutionId &&
        one.stepKey.slice(0, 6) === pause.stepKey.slice(0, 6),
    );
    return same ?? super.findOrCreateByStepKey(pause);
  }

  override async findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined> {
    if (this.tweaks.slow === this.who) await tick();
    if (this.tweaks.cold === this.who && !this.#isWarm) await tick();
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    if (found !== undefined) this.#isWarm = true;
    return this.tweaks.found === undefined ? found : this.tweaks.found(found);
  }

  override resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const plan = this.tweaks.resolve ?? resolveChange;
    return this.#change("resolve", tenantId, pauseId, (pause) =>
      plan(pause, answer, at, recipients),
    );
  }

  override cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const plan = this.tweaks.cancel ?? cancelChange;
    return this.#change("cancel", tenantId, pauseId, (pause) =>
      plan(pause, resolution, at, recipients),
    );
  }

  override expireByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const plan = this.tweaks.expire ?? expireChange;
    return this.#change("expire", tenantId, pauseId, (pause) =>
      plan(pause, expiry, at, recipients),
    );
  }

  override extendByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseDeadlineChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const plan = this.tweaks.extend ?? extendChange;
    return this.#change("extend", tenantId, pauseId, (pause) =>
      plan(pause, change, at, recipients),
    );
  }
}

const pairOf = (tweaks: Tweaks) => {
  const first = new Instance("first", tweaks);
  return { first, second: new Instance("second", tweaks, first) };
};

async function outcomeOf(one: Case, tweaks: Tweaks): Promise<"pass" | "assertion" | "crash"> {
  try {
    await one.run(pairOf(tweaks) as never);
    return "pass";
  } catch (error) {
    return error instanceof Error && error.name === "AssertionError" ? "assertion" : "crash";
  }
}

const caseIn = (cases: readonly Case[], start: string): Case => {
  const found = cases.find((one) => one.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};
const deadline = (start: string): Case => caseIn(DEADLINE_CASES, start);
const race = (start: string): Case => caseIn(EXTEND_RACE_CASES, start);

const RACE_AT = "an answer 1 ms before the deadline";
const AT_AND_AFTER = "resolve at `expiresAt` and after";
const ANY_TIME = "a pause without `expiresAt`";
const VS_EXPIRE = "two instances race resolve vs expire";
const CANCELS = "cancel Cancelled or TreeEnded";
const CANCEL_BEFORE = "cancel before `expiresAt`";
const EXPIRE = "expire before `expiresAt`";

/** The sound answer; a refused one on a pending pause is answered all the same, stored nowhere. */
const answeredNotStored = (
  pause: PauseRecord,
  answer: PauseAnswer,
  at: Date,
  recipients: PauseRecipients,
): Planned | undefined =>
  resolveChange(pause, answer, at, recipients) ??
  (pause.status === PauseStatus.Pending ? { pause, notices: [], unstored: true } : undefined);

const ignoringDeadline = (
  pause: PauseRecord,
  answer: PauseAnswer,
  _at: Date,
  recipients: PauseRecipients,
): Planned | undefined => resolveChange(pause, answer, EPOCH, recipients);

/** A stored pause as it is, with a time-ordered condition tweaked by `soundOr`. */
const extendWhen =
  (
    store: boolean,
    condition: (pause: PauseRecord, change: PauseDeadlineChange, at: Date) => boolean,
  ) =>
  (
    pause: PauseRecord,
    change: PauseDeadlineChange,
    at: Date,
    recipients: PauseRecipients,
  ): Planned | undefined => {
    const sound = extendChange(pause, change, at, recipients);
    if (sound !== undefined || !condition(pause, change, at)) return sound;
    return { pause: { ...pause, expiresAt: change.expiresAt }, notices: [], unstored: true };
  };

const DEADLINE_BROKEN: readonly (readonly [Case, string, Tweaks])[] = [
  [
    deadline(RACE_AT),
    "an answer at the deadline is taken, the second instance cold",
    {
      cold: "second",
      resolve: (pause, answer, at, recipients) =>
        resolveChange(pause, answer, shifted(at, at.toISOString() === FROM ? -1 : 0), recipients),
    },
  ],
  [
    deadline(RACE_AT),
    "an answer at the deadline is taken",
    {
      resolve: (pause, answer, at, recipients) =>
        resolveChange(pause, answer, shifted(at, at.toISOString() === FROM ? -1 : 0), recipients),
    },
  ],
  [
    deadline(RACE_AT),
    "the answer taken is answered as it was",
    { answers: { resolve: (_answered, before) => before } },
  ],
  [
    deadline(RACE_AT),
    "an answer after the deadline is answered but stored nowhere",
    { resolve: answeredNotStored },
  ],
  [
    deadline(RACE_AT),
    "a pause answered is gone for a lookup",
    { found: (found) => (found?.status === PauseStatus.Resolved ? undefined : found) },
  ],
  [
    deadline(AT_AND_AFTER),
    "an answer at the deadline is taken",
    {
      resolve: (pause, answer, at, recipients) =>
        resolveChange(pause, answer, shifted(at, at.toISOString() === FROM ? -1 : 0), recipients),
    },
  ],
  [
    deadline(AT_AND_AFTER),
    "an answer refused at the deadline still closes the pause",
    {
      resolve: (pause, answer, at, recipients) =>
        resolveChange(pause, answer, at, recipients) ??
        (pause.status === PauseStatus.Pending
          ? { pause: { ...pause, status: PauseStatus.Resolved }, notices: [], hidden: true }
          : undefined),
    },
  ],
  [
    deadline(ANY_TIME),
    "an answer is answered as it was",
    { answers: { resolve: (_answered, before) => before } },
  ],
  [deadline(VS_EXPIRE), "an answer after the deadline is taken", { resolve: ignoringDeadline }],
  [
    deadline(VS_EXPIRE),
    "an answer after the deadline is answered but stored nowhere",
    { resolve: answeredNotStored },
  ],
  [
    deadline(VS_EXPIRE),
    "an expiry is answered as a resolved pause",
    {
      answers: { expire: (answered) => ({ ...answered, status: PauseStatus.Resolved }) },
    },
  ],
  [
    deadline(VS_EXPIRE),
    "an expiry is answered as a cancelled one",
    {
      answers: {
        expire: (answered) => ({ ...answered, resolution: PauseResolution.Cancelled }),
      },
    },
  ],
  [
    deadline(CANCELS),
    "a cancel is due only at the deadline itself",
    {
      cancel: (pause, resolution, at, recipients) =>
        cancelChange(
          pause,
          resolution,
          at.toISOString() === pause.expiresAt ? at : EPOCH,
          recipients,
        ),
    },
  ],
  [
    deadline(CANCELS),
    "a cancel after the deadline answers nothing",
    {
      answers: {
        cancel: (answered) =>
          answered.resolution === PauseResolution.Expired ? undefined : answered,
      },
    },
  ],
  [
    deadline(CANCELS),
    "a cancel is never due",
    {
      cancel: (pause, resolution, _at, recipients) =>
        cancelChange(pause, resolution, EPOCH, recipients),
    },
  ],
  [
    deadline(CANCEL_BEFORE),
    "a cancel records Cancelled whatever it was asked",
    {
      answers: {
        cancel: (answered) => ({ ...answered, resolution: PauseResolution.Cancelled }),
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry before the deadline applies",
    {
      expire: (pause, expiry, at, recipients) =>
        expireChange(pause, expiry, at.toISOString() < FROM ? new Date(FROM) : at, recipients),
    },
  ],
  [
    deadline(EXPIRE),
    "the step key of a second pause collides with the first",
    { collideKeys: true },
  ],
  [
    deadline(EXPIRE),
    "an expiry with an answer is answered as cancelled",
    {
      answers: {
        expire: (answered) =>
          answered.status === PauseStatus.Resolved
            ? { ...answered, status: PauseStatus.Cancelled }
            : answered,
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry with an answer is answered as expired",
    {
      answers: {
        expire: (answered) =>
          answered.status === PauseStatus.Resolved
            ? { ...answered, resolution: PauseResolution.Expired }
            : answered,
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry with an answer is answered at another time",
    {
      answers: {
        expire: (answered) =>
          answered.status === PauseStatus.Resolved
            ? { ...answered, resolvedAt: "2026-01-05T00:00:00.000Z" }
            : answered,
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry with an answer keeps who answered",
    {
      answers: {
        expire: (answered) =>
          answered.status === PauseStatus.Resolved && answered.answer !== undefined
            ? { ...answered, answer: { ...answered.answer, answeredBy: "manager-17" } }
            : answered,
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry with an answer answers another decision",
    {
      answers: {
        expire: (answered) =>
          answered.status === PauseStatus.Resolved && answered.answer !== undefined
            ? { ...answered, answer: { ...answered.answer, decision: { approved: false } } }
            : answered,
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry without an answer is answered as resolved",
    {
      answers: {
        expire: (answered) =>
          answered.status === PauseStatus.Cancelled
            ? { ...answered, status: PauseStatus.Resolved }
            : answered,
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry without an answer is answered as cancelled",
    {
      answers: {
        expire: (answered) =>
          answered.status === PauseStatus.Cancelled
            ? { ...answered, resolution: PauseResolution.Cancelled }
            : answered,
      },
    },
  ],
  [
    deadline(EXPIRE),
    "an expiry without an answer forgets why",
    {
      answers: {
        expire: (answered) => {
          if (answered.status !== PauseStatus.Cancelled) return answered;
          const { expiryProblem: _problem, ...rest } = answered;
          return rest;
        },
      },
    },
  ],
];

const sameDeadline = (pause: PauseRecord, change: PauseDeadlineChange): boolean =>
  change.previousExpiresAt === pause.expiresAt;

const RACE_BROKEN: readonly (readonly [Case, string, Tweaks])[] = [
  [
    race("an extension whose write"),
    "an extension just after the deadline is answered, stored nowhere",
    {
      extend: extendWhen(false, (pause, change, at) => {
        const past = at.getTime() - Date.parse(pause.expiresAt ?? "");
        return sameDeadline(pause, change) && past > 0 && past <= HOUR;
      }),
    },
  ],
  [
    race("an extension whose write"),
    "an extension long after the deadline is answered, stored nowhere",
    {
      extend: extendWhen(false, (pause, change, at) => {
        const past = at.getTime() - Date.parse(pause.expiresAt ?? "");
        return sameDeadline(pause, change) && past > HOUR;
      }),
    },
  ],
  [
    race("an extension whose write"),
    "an extension is answered as the pause was",
    { answers: { extend: (_answered, before) => before } },
  ],
  [race("an extension whose write"), "a lookup finds nothing", { found: () => undefined }],
  [
    race("extend only over the deadline"),
    "an extension over a later deadline than the stored one is answered, stored nowhere",
    {
      extend: extendWhen(
        false,
        (pause, change) => change.previousExpiresAt > (pause.expiresAt ?? ""),
      ),
    },
  ],
  [
    race("extend only over the deadline"),
    "an extension over an earlier deadline than the stored one is answered, stored nowhere",
    {
      extend: extendWhen(
        false,
        (pause, change) => change.previousExpiresAt < (pause.expiresAt ?? ""),
      ),
    },
  ],
  [
    race("extend only over the deadline"),
    "the first extension is answered as the pause was",
    {
      answers: {
        extend: (answered, before) => (answered.expiresAt === LATER ? before : answered),
      },
    },
  ],
  [
    race("extend only over the deadline"),
    "the second extension is answered as the pause was",
    {
      answers: {
        extend: (answered, before) => (answered.expiresAt === EVEN_LATER ? before : answered),
      },
    },
  ],
  [
    race("extend only over the deadline"),
    "an extension is answered as the pause was",
    { answers: { extend: (_answered, before) => before } },
  ],
  [race("extend only over the deadline"), "a lookup finds nothing", { found: () => undefined }],
  [
    race("an extension not later"),
    "an extension to the stored deadline, from the first one, is answered, stored nowhere",
    {
      extend: extendWhen(
        false,
        (pause, change) =>
          sameDeadline(pause, change) &&
          change.expiresAt === pause.expiresAt &&
          pause.expiresAt === FROM,
      ),
    },
  ],
  [
    race("an extension not later"),
    "an extension to the stored deadline, from a moved one, is answered, stored nowhere",
    {
      extend: extendWhen(
        false,
        (pause, change) =>
          sameDeadline(pause, change) &&
          change.expiresAt === pause.expiresAt &&
          pause.expiresAt === LATER,
      ),
    },
  ],
  [
    race("an extension not later"),
    "an extension a little earlier than the first deadline is answered, stored nowhere",
    {
      extend: extendWhen(
        false,
        (pause, change) =>
          sameDeadline(pause, change) &&
          pause.expiresAt === FROM &&
          change.expiresAt < FROM &&
          Date.parse(FROM) - Date.parse(change.expiresAt) < 10 * 60_000,
      ),
    },
  ],
  [
    race("an extension not later"),
    "an extension earlier than a moved deadline is answered, stored nowhere",
    {
      extend: extendWhen(
        false,
        (pause, change) =>
          sameDeadline(pause, change) &&
          pause.expiresAt === LATER &&
          change.expiresAt < LATER &&
          Date.parse(LATER) - Date.parse(change.expiresAt) < 2 * HOUR,
      ),
    },
  ],
  [
    race("an extension not later"),
    "an extension is answered as the pause was",
    { answers: { extend: (_answered, before) => before } },
  ],
  [race("an extension not later"), "a lookup finds nothing", { found: () => undefined }],
  [
    race("two concurrent extends"),
    "a deadline read before another's move still takes a later one",
    {
      slow: "first",
      extend: (pause, change, at, recipients) =>
        extendChange(
          pause,
          { ...change, previousExpiresAt: pause.expiresAt ?? "" },
          at,
          recipients,
        ),
    },
  ],
  [
    race("two concurrent extends"),
    "a deadline moves to an earlier one when the read is stale",
    {
      extend: (pause, change, at, recipients) =>
        extendChange(pause, change, at, recipients) ??
        (pause.status === PauseStatus.Pending &&
        change.expiresAt < (pause.expiresAt ?? "") &&
        change.expiresAt > at.toISOString()
          ? { pause: { ...pause, expiresAt: change.expiresAt }, notices: [] }
          : undefined),
    },
  ],
  [
    race("two concurrent extends"),
    "an extension to the stored deadline is taken",
    {
      extend: (pause, change, at, recipients) =>
        extendChange(pause, change, at, recipients) ??
        (sameDeadline(pause, change) && change.expiresAt === pause.expiresAt
          ? { pause, notices: [] }
          : undefined),
    },
  ],
  [race("two concurrent extends"), "a lookup finds nothing", { found: () => undefined }],
  [
    race("two concurrent extends"),
    "the deadline is stored without its milliseconds",
    {
      found: (found) =>
        found?.expiresAt === undefined
          ? found
          : { ...found, expiresAt: found.expiresAt.replace(".000Z", "Z") },
    },
  ],
  [
    race("two concurrent extends"),
    "the first instance is slower and an extension can be taken once only",
    {
      slow: "first",
      extend: (pause, change, at, recipients) =>
        pause.expiresAt === FROM ? extendChange(pause, change, at, recipients) : undefined,
    },
  ],
  [
    race("extend racing the expiry"),
    "an extension of a closed pause is taken",
    {
      extend: (pause, change, at, recipients) =>
        extendChange(pause, change, at, recipients) ??
        (pause.status !== PauseStatus.Pending && sameDeadline(pause, change)
          ? { pause: { ...pause, expiresAt: change.expiresAt }, notices: [] }
          : undefined),
    },
  ],
  [
    race("extend racing the expiry"),
    "an extension of an answered pause is answered with another deadline",
    {
      extend: (pause, change, at, recipients) =>
        extendChange(pause, change, at, recipients) ??
        (pause.status === PauseStatus.Resolved
          ? {
              pause: { ...pause, expiresAt: "2030-01-01T00:00:00.000Z" },
              notices: [],
              unstored: true,
            }
          : undefined),
    },
  ],
  [
    race("extend racing the expiry"),
    "an answer is taken but answered nothing",
    {
      answers: {
        resolve: () => undefined,
      },
    },
  ],
  [race("extend racing the expiry"), "a lookup finds nothing", { found: () => undefined }],
  [
    race("extend racing the expiry"),
    "the step key of a second pause collides with the first",
    { collideKeys: true },
  ],
  [
    race("an extension resets"),
    "an extension keeps the bound",
    {
      answers: {
        extend: (answered, before) => ({ ...answered, expiryBound: before.expiryBound }),
      },
    },
  ],
  [race("an extension resets"), "a lookup finds nothing", { found: () => undefined }],
];

/** Sound stores: a slow instance leaves the other's call first, in either order. */
const SOUND_TWEAKS: readonly (readonly [string, Tweaks])[] = [
  ["sound", {}],
  ["the first instance slow", { slow: "first" }],
  ["the second instance slow", { slow: "second" }],
  ["the second instance cold", { cold: "second" }],
];

describe("#1366: the deadline and extension race contract cases", () => {
  for (const [title, tweaks] of SOUND_TWEAKS)
    it(`every case passes on a sound store (${title})`, async () => {
      for (const one of [...DEADLINE_CASES, ...EXTEND_RACE_CASES])
        expect(await outcomeOf(one, tweaks), one.name).toBe("pass");
    });

  for (const [one, title, tweaks] of [...DEADLINE_BROKEN, ...RACE_BROKEN])
    it(`"${one.name.slice(0, 50)}" fails (an assertion) on a store where ${title}`, async () => {
      expect(await outcomeOf(one, tweaks)).toBe("assertion");
    });
});
