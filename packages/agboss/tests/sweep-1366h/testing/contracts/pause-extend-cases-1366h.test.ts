/**
 * #1366: the paused-execution contract's extend, remind, close-untaken and step-key cases
 * (`paused-execution-extend.cases.ts`, #910 I3) judge a store by what it answers and keeps: each
 * passes on the sound in-memory store shared by two instances and FAILS (with an assertion, never a
 * crash) on a store that breaks the rule the case names: an extension answered to an earlier time or
 * at the deadline, an answer that is not the changed pause, an extension of a pause without a deadline
 * or of a resolved one, a reminder before its time, at the deadline, twice or left on the record, a
 * close of a pause still pending or closed already, a closed pause answered without its answer,
 * resolution or time, and a lookup by step key that answers nothing, the wrong tree or the wrong tenant.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../../../src/infrastructure/in-memory-paused-execution.repository.js";
import type {
  PauseDeadlineChange,
  PauseRecipients,
} from "../../../../src/infrastructure/pause-notices.js";
import {
  PauseExpiryBound,
  PauseResolution,
  PauseStatus,
  type PauseRecord,
  type PauseUntakenResolution,
} from "../../../../src/infrastructure/pause-record.js";
import type { PausedExecutionRepository } from "../../../../src/infrastructure/paused-execution.repository.js";
import type { ContractCase } from "../../../../src/testing/contracts/define.js";
import { EXTEND_CASES } from "../../../../src/testing/contracts/paused-execution-extend.cases.js";

type Case = ContractCase<PausedExecutionRepository>;
type Found = PauseRecord | undefined;

interface Tweaks {
  /** What an extension answers: the pause as found, the change, the time, and the real call. */
  readonly extend?: (
    found: Found,
    change: PauseDeadlineChange,
    at: Date,
    real: () => Promise<Found>,
  ) => Promise<Found>;
  readonly remind?: (found: Found, at: Date, real: () => Promise<boolean>) => Promise<boolean>;
  readonly close?: (
    found: Found,
    resolution: PauseUntakenResolution,
    real: () => Promise<Found>,
  ) => Promise<Found>;
  /** What a lookup by (tenant, pause id) answers. */
  readonly find?: (found: Found) => Found;
  /** What a lookup by (tenant, root, step key) answers; `real` is the sound one. */
  readonly findStep?: (
    ask: { tenantId: string; rootExecutionId: string; stepKey: string },
    real: Found,
    all: readonly PauseRecord[],
  ) => Found;
  /** A pause saved under an empty step key is refused. */
  readonly refusesEmptyStepKey?: boolean;
  /** A pause with a reminder keeps it on the record after the reminder was sent. */
  readonly keepsRemindAt?: boolean;
}

class Instance extends InMemoryPausedExecutionRepository {
  constructor(
    readonly tweaks: Tweaks,
    sharing?: Instance,
  ) {
    super();
    if (sharing !== undefined) Reflect.set(this, "book", Reflect.get(sharing, "book"));
  }

  override findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    if (this.tweaks.refusesEmptyStepKey === true && pause.stepKey === "")
      throw new Error("an empty step key");
    return super.findOrCreateByStepKey(pause);
  }

  override async findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<Found> {
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    const shown =
      this.tweaks.keepsRemindAt === true && found !== undefined && REMINDED.has(pauseId)
        ? { ...found, remindAt: REMINDED.get(pauseId) }
        : found;
    return this.tweaks.find === undefined ? shown : this.tweaks.find(shown);
  }

  override async extendByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseDeadlineChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<Found> {
    const real = () => super.extendByTenantIdAndPauseId(tenantId, pauseId, change, at, recipients);
    if (this.tweaks.extend === undefined) return real();
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    return this.tweaks.extend(found, change, at, real);
  }

  override async remindByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    const real = async () => {
      const done = await super.remindByTenantIdAndPauseId(tenantId, pauseId, at, recipients);
      if (done && found !== undefined) REMINDED.set(pauseId, found.remindAt);
      return done;
    };
    return this.tweaks.remind === undefined ? real() : this.tweaks.remind(found, at, real);
  }

  override async closeUntakenByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseUntakenResolution,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<Found> {
    const real = () =>
      super.closeUntakenByTenantIdAndPauseId(tenantId, pauseId, resolution, at, recipients);
    if (this.tweaks.close === undefined) return real();
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    return this.tweaks.close(found, resolution, real);
  }

  override async findByTenantIdAndRootExecutionIdAndStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ): Promise<Found> {
    const real = await super.findByTenantIdAndRootExecutionIdAndStepKey(
      tenantId,
      rootExecutionId,
      stepKey,
    );
    return this.tweaks.findStep === undefined
      ? real
      : this.tweaks.findStep({ tenantId, rootExecutionId, stepKey }, real, this.pauses());
  }
}

/** The reminders sent, by pause id: what a record kept (a fresh map per pair). */
let REMINDED = new Map<string, string | undefined>();

const pairOf = (tweaks: Tweaks) => {
  REMINDED = new Map();
  const first = new Instance(tweaks);
  return { first, second: new Instance(tweaks, first) };
};

const caseNamed = (start: string): Case => {
  const found = EXTEND_CASES.find((one) => one.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};

async function outcomeOf(start: string, tweaks: Tweaks): Promise<"pass" | "assertion" | "crash"> {
  try {
    await caseNamed(start).run(pairOf(tweaks) as never);
    return "pass";
  } catch (error) {
    return error instanceof Error && error.name === "AssertionError" ? "assertion" : "crash";
  }
}

const EXTEND = "extend only while Pending";
const NOT_EXTENDED = "a pause without a deadline";
const REMIND = "remind once";
const CLOSE = "closeUntaken applies only";
const STEP = "findByTenantIdAndRootExecutionIdAndStepKey finds";

const time = (iso: string | undefined): number => new Date(iso ?? "").getTime();
/** The change names a deadline (a change without one is no extension). */
const hasExpiry = (change: PauseDeadlineChange): boolean =>
  Object.keys(change).includes("expiresAt");
const isPending = (pause: PauseRecord): boolean => pause.status === PauseStatus.Pending;

const EXTENDING: readonly (readonly [string, string, Tweaks])[] = [
  [
    EXTEND,
    "answers an extension to an earlier time, writing nothing",
    {
      extend: async (found, change, _at, real) =>
        found !== undefined && time(change.expiresAt) <= time(found.expiresAt) ? found : real(),
    },
  ],
  [
    EXTEND,
    "answers an extension at the deadline, writing nothing",
    {
      extend: async (found, _change, at, real) =>
        found !== undefined && at.getTime() >= time(found.expiresAt) ? found : real(),
    },
  ],
  [
    EXTEND,
    "answers the pause as it was before the extension",
    {
      extend: async (found, _change, _at, real) => {
        const moved = await real();
        return moved === undefined ? undefined : found;
      },
    },
  ],
  [
    EXTEND,
    "answers an extended pause with another expiry bound",
    {
      extend: async (_found, _change, _at, real) => {
        const moved = await real();
        return moved === undefined ? undefined : { ...moved, expiryBound: PauseExpiryBound.Quorum };
      },
    },
  ],
  [EXTEND, "finds no pause after an extension", { find: () => undefined }],
  [
    NOT_EXTENDED,
    "extends a pause without a deadline",
    {
      extend: async (found, change, _at, real) =>
        found !== undefined && found.expiresAt === undefined && hasExpiry(change)
          ? { ...found, expiresAt: change.expiresAt }
          : real(),
    },
  ],
  [
    NOT_EXTENDED,
    "extends a pause no longer pending",
    {
      extend: async (found, change, _at, real) =>
        found !== undefined && !isPending(found) && hasExpiry(change)
          ? { ...found, expiresAt: change.expiresAt }
          : real(),
    },
  ],
  [
    REMIND,
    "reminds before the time of the reminder",
    {
      remind: async (found, at, real) =>
        found !== undefined && at.getTime() < time(found.remindAt) ? true : real(),
    },
  ],
  [
    REMIND,
    "reminds twice when two instances remind at once",
    {
      remind: async (found, at, real) => {
        const done = await real();
        const due = at.getTime() >= time(found?.remindAt) && at.getTime() < time(found?.expiresAt);
        return found !== undefined && due ? true : done;
      },
    },
  ],
  [REMIND, "keeps the reminder on the record after it was sent", { keepsRemindAt: true }],
  [
    REMIND,
    "reminds at the deadline",
    {
      remind: async (found, at, real) =>
        found !== undefined && at.getTime() >= time(found.expiresAt) ? true : real(),
    },
  ],
  [
    CLOSE,
    "closes a pause still pending",
    {
      close: async (found, resolution, real) =>
        found !== undefined && isPending(found)
          ? { ...found, status: PauseStatus.Cancelled, resolution }
          : real(),
    },
  ],
  [
    CLOSE,
    "closes a pause closed already",
    {
      close: async (found, _resolution, real) =>
        found?.status === PauseStatus.Cancelled ? found : real(),
    },
  ],
  [
    CLOSE,
    "answers a closed pause without its answer",
    {
      close: async (_found, _resolution, real) => {
        const closed = await real();
        return closed === undefined ? undefined : { ...closed, answer: undefined };
      },
    },
  ],
  [
    CLOSE,
    "answers a closed pause with another resolution",
    {
      close: async (_found, _resolution, real) => {
        const closed = await real();
        return closed === undefined
          ? undefined
          : { ...closed, resolution: PauseResolution.Reassigned };
      },
    },
  ],
  [
    CLOSE,
    "answers a closed pause with another status",
    {
      close: async (_found, _resolution, real) => {
        const closed = await real();
        return closed === undefined ? undefined : { ...closed, status: PauseStatus.Resolved };
      },
    },
  ],
  [
    CLOSE,
    "answers a closed pause with the time of its answer",
    {
      close: async (_found, _resolution, real) => {
        const closed = await real();
        return closed === undefined
          ? undefined
          : { ...closed, resolvedAt: "2026-01-05T09:45:00.000Z" };
      },
    },
  ],
  [STEP, "answers no pause by step key", { findStep: () => undefined }],
  [
    STEP,
    "answers no pause in the first tree",
    { findStep: (ask, real) => (ask.rootExecutionId === "run-1" ? undefined : real) },
  ],
  [
    STEP,
    "answers a pause of another tree when its tree has none",
    {
      findStep: (ask, real, all) =>
        real ?? all.find((one) => one.tenantId === ask.tenantId && one.stepKey === ask.stepKey),
    },
  ],
  [
    STEP,
    "takes a tree whose name starts like another's for it",
    {
      findStep: (ask, real, all) =>
        real ??
        all.find(
          (one) =>
            one.tenantId === ask.tenantId &&
            one.stepKey === ask.stepKey &&
            one.rootExecutionId.slice(0, 4) === ask.rootExecutionId.slice(0, 4),
        ),
    },
  ],
  [
    STEP,
    "reads any named tenant as the default one",
    {
      findStep: (ask, real, all) =>
        real ??
        (ask.tenantId === ""
          ? undefined
          : all.find(
              (one) =>
                one.tenantId === "default" &&
                one.rootExecutionId === ask.rootExecutionId &&
                one.stepKey === ask.stepKey,
            )),
    },
  ],
];

describe("#1366: the paused-execution contract's extend cases", () => {
  it("every case passes on the sound store shared by two instances", async () => {
    for (const one of EXTEND_CASES) expect(await outcomeOf(one.name, {}), one.name).toBe("pass");
  });

  for (const [start, title, tweaks] of EXTENDING)
    it(`"${start}" fails (an assertion) on a store that ${title}`, async () => {
      expect(await outcomeOf(start, tweaks)).toBe("assertion");
    });

  it("every case passes on a store that refuses a pause saved under an empty step key", async () => {
    for (const one of EXTEND_CASES)
      expect(await outcomeOf(one.name, { refusesEmptyStepKey: true }), one.name).toBe("pass");
  });

  it("the remind case passes on a store that finds no pause after the reminders", async () => {
    expect(await outcomeOf(REMIND, { find: () => undefined })).toBe("pass");
  });
});
