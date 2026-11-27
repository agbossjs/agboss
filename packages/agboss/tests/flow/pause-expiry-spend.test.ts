import { StepError } from "../../src/core/error-families/step-errors.js";
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { usd } from "../../src/units/index.js";
/**
 * #1366: the spend a pause's expiry fails the step with — when the run's deadline bound the pause the failure is
 * `LimitError.Deadline` with the execution's spend (its state's records and the step's own) and the step's
 * records; when the pause's own deadline did, `StepError.PauseExpired` carries the step's records. The budgets are
 * asked with the same records first.
 */
import { describe, expect, it } from "vitest";
import { ComponentKind } from "../../src/flow/runtime/records.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { expiryFailureOf } from "../../src/flow/runtime/pause-expiry-failure.js";
import { PauseExpiryBound, type PauseRecord } from "../../src/infrastructure/pause-record.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const AT = "2026-01-01T00:10:00.000Z";

const pause = (bound: PauseExpiryBound): PauseRecord =>
  ({
    expiryBound: bound,
    expiresAt: new Date(AT),
    boundAt: new Date(AT),
    askedAt: new Date("2026-01-01T00:00:00.000Z"),
    channel: "desk",
    kind: "approval",
  }) as never;

function site() {
  const checked: (readonly UsageRecord[])[] = [];
  const state = [record(0.25, "state")];
  const usage = [record(0.5, "step")];
  return {
    checked,
    state,
    usage,
    site: {
      step: "ask",
      stepKind: ComponentKind.ExternalTask,
      state,
      usage,
      path: ["flow", "ask"],
      budgets: {
        check: (spent: readonly UsageRecord[], _path: unknown, loop?: readonly UsageRecord[]) => {
          checked.push(spent, loop ?? []);
        },
      },
    } as never,
  };
}

describe("#1366: what a pause's expiry fails the step with", () => {
  it("the run's deadline: the spend of the state and the step, the step's records, the budgets asked first", () => {
    const given = site();

    const error = expiryFailureOf(pause(PauseExpiryBound.RunDeadline), given.site);

    expect(error).toBeInstanceOf(LimitError.Deadline);
    expect(error).toMatchObject({ spentUsd: usd(0.75), usage: given.usage, path: ["flow", "ask"] });
    expect(given.checked).toEqual([given.state, given.usage]);
  });

  it("the pause's own deadline: the step's records on a StepError.PauseExpired", () => {
    const given = site();

    const error = expiryFailureOf(pause(PauseExpiryBound.Pause), given.site);

    expect(error).toBeInstanceOf(StepError.PauseExpired);
    expect(error).toMatchObject({ usage: given.usage });
  });

  it("the run's deadline, given as what the pause waited: from the ask to the deadline, none when it ran out before the ask", () => {
    const waited = expiryFailureOf(pause(PauseExpiryBound.RunDeadline), site().site);
    const before = expiryFailureOf(
      { ...pause(PauseExpiryBound.RunDeadline), askedAt: new Date("2026-01-01T00:20:00.000Z") },
      site().site,
    );

    expect(waited).toMatchObject({ deadline: 600_000, deadlineAt: new Date(AT) });
    expect(before).toMatchObject({ deadline: 0 });
  });
});
