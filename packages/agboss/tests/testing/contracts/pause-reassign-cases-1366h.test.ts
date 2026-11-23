/**
 * #1366: the reassignment contract cases (#946) fail on a pause store that breaks the rule each
 * case checks — one broken way per rule — and pass on the sound in-memory one: what a reassignment
 * answers, which step key and pause a lookup finds after it, which pauses it refuses and that a
 * refusal leaves nothing behind.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import type {
  PauseRecipients,
  PauseReplacement,
} from "../../../src/infrastructure/pause-notices.js";
import { PauseStatus, type PauseRecord } from "../../../src/infrastructure/pause-record.js";
import { reassignChange } from "../../../src/infrastructure/pause-reassign-transition.js";
import type { PausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { pauseOf } from "../../../src/testing/contracts/paused-execution-data.js";
import { REASSIGN_CASES } from "../../../src/testing/contracts/paused-execution-reassign.cases.js";
import type { PauseChange } from "../../../src/infrastructure/pause-transitions.js";

type Make = () => PausedExecutionRepository;

const A = "a reassignment closes the old pause Reassigned";
const B = "the step key is still the old pause's";
const C = "a second reassignment is ~r2";
const D = "a step key already taken";
const E = "refused, nothing written";
const F = "a pause without a deadline";

const caseNamed = (start: string) => {
  const found = REASSIGN_CASES.find((one) => one.name.startsWith(start));
  if (found === undefined) throw new Error(start);
  return found;
};

async function outcomeOf(name: string, make: Make): Promise<"pass" | "fail"> {
  const store = make();
  try {
    await caseNamed(name).run({ first: store, second: store } as never);
    return "pass";
  } catch {
    return "fail";
  }
}

/** The store's reassignment with a change of what it plans or answers. */
class Tweaked extends InMemoryPausedExecutionRepository {
  protected plan(
    pause: PauseRecord,
    change: PauseChange | undefined,
    _replacement: PauseReplacement,
  ): PauseChange | undefined {
    return change;
  }
  protected answer(
    answered: PauseRecord | undefined,
    _pause: PauseRecord | undefined,
    _replacement: PauseReplacement,
    _at: Date,
  ): PauseRecord | undefined {
    return answered;
  }
  protected opened(pause: PauseRecord): PauseRecord {
    return pause;
  }

  override reassignByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    replacement: PauseReplacement,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const before = this.book.find(tenantId, pauseId);
    const taken = new Set(
      this.pauses()
        .filter(
          (one) => one.rootExecutionId === before?.rootExecutionId && one.tenantId === tenantId,
        )
        .map((one) => one.stepKey),
    );
    const reassigned = this.book.change(tenantId, pauseId, (pause) =>
      this.plan(
        pause,
        reassignChange(this.opened(pause), replacement, taken, at, recipients),
        replacement,
      ),
    );
    const found =
      reassigned === undefined ? undefined : this.book.find(tenantId, replacement.pauseId);
    return Promise.resolve(this.answer(found, before, replacement, at));
  }
}

const tweaked = (
  tweaks: Partial<{
    plan: Tweaked["plan"];
    answer: Tweaked["answer"];
    opened: Tweaked["opened"];
  }>,
): Make => {
  class One extends Tweaked {
    protected override plan(...args: Parameters<Tweaked["plan"]>) {
      return tweaks.plan === undefined ? super.plan(...args) : tweaks.plan(...args);
    }
    protected override answer(...args: Parameters<Tweaked["answer"]>) {
      return tweaks.answer === undefined ? super.answer(...args) : tweaks.answer(...args);
    }
    protected override opened(pause: PauseRecord) {
      return tweaks.opened === undefined ? super.opened(pause) : tweaks.opened(pause);
    }
  }
  return () => new One();
};

/** Replaces the inserted replacement of a plan. */
const inserting =
  (change: (inserted: PauseRecord) => PauseRecord): Tweaked["plan"] =>
  (_pause, planned) =>
    planned?.inserted === undefined ? planned : { ...planned, inserted: change(planned.inserted) };

class FindOrCreateAnswersReplacement extends InMemoryPausedExecutionRepository {
  override async findOrCreateByStepKey(pause: PauseRecord) {
    const found = await super.findOrCreateByStepKey(pause);
    return found.reassignedTo === undefined
      ? found
      : (this.book.find(found.tenantId, found.reassignedTo) ?? found);
  }
}

class FindOrCreateMakesASecond extends InMemoryPausedExecutionRepository {
  override async findOrCreateByStepKey(pause: PauseRecord) {
    const found = await super.findOrCreateByStepKey(pause);
    if (found.pauseId !== pause.pauseId && found.reassignedTo !== undefined)
      this.book.insert({ ...pause, stepKey: `${pause.stepKey}~other` });
    return found;
  }
}

class StepKeyLookupFindsTheOld extends InMemoryPausedExecutionRepository {
  override findByTenantIdAndRootExecutionIdAndStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ) {
    return super.findByTenantIdAndRootExecutionIdAndStepKey(
      tenantId,
      rootExecutionId,
      stepKey.replace(/~r\d+$/u, ""),
    );
  }
}

/** Answers an unknown pause with a record. */
class ReassignsTheUnknown extends InMemoryPausedExecutionRepository {
  override async reassignByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    replacement: PauseReplacement,
    at: Date,
    recipients: PauseRecipients,
  ) {
    return (
      (await super.reassignByTenantIdAndPauseId(tenantId, pauseId, replacement, at, recipients)) ??
      (this.book.find(tenantId, pauseId) === undefined ? pauseOf(replacement.pauseId) : undefined)
    );
  }
}

/** Finds the pause by its id in any tenant. */
class IgnoresTheTenant extends InMemoryPausedExecutionRepository {
  override reassignByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    replacement: PauseReplacement,
    at: Date,
    recipients: PauseRecipients,
  ) {
    const found = this.pauses().find((one) => one.pauseId === pauseId);
    return super.reassignByTenantIdAndPauseId(
      found?.tenantId ?? tenantId,
      pauseId,
      replacement,
      at,
      recipients,
    );
  }
}

/** Refuses with `undefined` but leaves the replacement of the refused pause where `where` says. */
const writesYetRefuses = (
  where: (pause: PauseRecord, at: Date) => Partial<PauseRecord> | undefined,
): Make => {
  class One extends InMemoryPausedExecutionRepository {
    override async reassignByTenantIdAndPauseId(
      tenantId: string,
      pauseId: string,
      replacement: PauseReplacement,
      at: Date,
      recipients: PauseRecipients,
    ) {
      const pause = this.book.find(tenantId, pauseId);
      const done = await super.reassignByTenantIdAndPauseId(
        tenantId,
        pauseId,
        replacement,
        at,
        recipients,
      );
      const left = pause === undefined || done !== undefined ? undefined : where(pause, at);
      if (left !== undefined)
        this.book.insert({
          ...pause,
          ...left,
          pauseId: replacement.pauseId,
          stepKey: `${pause?.stepKey ?? ""}~r9`,
        } as PauseRecord);
      return done;
    }
  }
  return () => new One();
};

const BROKEN: readonly (readonly [string, string, Make])[] = [
  [
    A,
    "answers a replacement that is not the stored one",
    tweaked({ answer: (found) => (found === undefined ? found : { ...found, isSent: true }) }),
  ],
  [
    A,
    "the replacement keeps its addressee unset",
    tweaked({ plan: inserting((one) => ({ ...one, assignee: "" })) }),
  ],
  [B, "findOrCreate answers the replacement", () => new FindOrCreateAnswersReplacement()],
  [B, "findOrCreate makes a second pause", () => new FindOrCreateMakesASecond()],
  [B, "the ~r1 key finds the old pause", () => new StepKeyLookupFindsTheOld()],
  [
    C,
    "the replacement keeps its addressee unset",
    tweaked({ plan: inserting((one) => ({ ...one, assignee: "" })) }),
  ],
  [
    C,
    "the replacement points at no pause",
    tweaked({ plan: inserting((one) => ({ ...one, reassignedFrom: one.pauseId })) }),
  ],
  [
    C,
    "the replacement has no step key suffix",
    tweaked({
      plan: inserting((one) => ({ ...one, stepKey: one.stepKey.replace(/~r\d+$/u, "") })),
    }),
  ],
  [
    D,
    "a taken step key is not skipped",
    tweaked({
      plan: inserting((one) => ({ ...one, stepKey: one.stepKey.replace(/~r\d+$/u, "~r1") })),
    }),
  ],
  [
    E,
    "a resolved pause is reassigned",
    tweaked({
      opened: (pause) =>
        pause.status === PauseStatus.Resolved ? { ...pause, status: PauseStatus.Pending } : pause,
    }),
  ],
  [
    E,
    "a cancelled pause is reassigned",
    tweaked({
      opened: (pause) =>
        pause.status === PauseStatus.Cancelled ? { ...pause, status: PauseStatus.Pending } : pause,
    }),
  ],
  [
    E,
    "a taken pause is reassigned",
    tweaked({
      opened: (pause) =>
        pause.status === PauseStatus.Taken ? { ...pause, status: PauseStatus.Pending } : pause,
    }),
  ],
  [E, "an unknown pause is answered", () => new ReassignsTheUnknown()],
  [E, "the tenant is ignored", () => new IgnoresTheTenant()],
  [
    E,
    "a refusal after the deadline leaves a replacement",
    writesYetRefuses((pause, at) =>
      pause.expiresAt !== undefined && pause.expiresAt < at.toISOString() ? {} : undefined,
    ),
  ],
  [
    E,
    "a refusal at the deadline leaves a replacement of another tree",
    writesYetRefuses((pause, at) =>
      pause.expiresAt === at.toISOString() ? { rootExecutionId: "run-other" } : undefined,
    ),
  ],
  [
    E,
    "a refusal of a Pending pause cancels it",
    tweaked({
      plan: (pause, planned) =>
        planned === undefined && pause.status === PauseStatus.Pending
          ? { pause: { ...pause, status: PauseStatus.Cancelled }, notices: [] }
          : planned,
    }),
  ],
  [
    F,
    "the replacement has a deadline",
    tweaked({ plan: inserting((one) => ({ ...one, expiresAt: "2031-01-01T00:00:00.000Z" })) }),
  ],
  [
    F,
    "the replacement is Taken",
    tweaked({ plan: inserting((one) => ({ ...one, status: PauseStatus.Taken })) }),
  ],
];

describe("#1366: the reassignment cases", () => {
  it("every case passes on the sound store", async () => {
    for (const name of [A, B, C, D, E, F])
      expect([name, await outcomeOf(name, () => new InMemoryPausedExecutionRepository())]).toEqual([
        name,
        "pass",
      ]);
  });

  for (const [name, broken, make] of BROKEN) {
    it(`${name.slice(0, 30)}... fails on: ${broken}`, async () => {
      expect(await outcomeOf(name, make)).toBe("fail");
    });
  }
});
