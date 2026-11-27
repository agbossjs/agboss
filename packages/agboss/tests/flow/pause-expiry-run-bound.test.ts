/**
 * #1366: whether the run's deadline bound a pause that expired (#941 D8, #945) — told apart from the record alone:
 * a pause extended up to exactly the deadline it was made under is the run's when the run's own deadline is not
 * later than the pause's, a tie included, so the failure is `LimitError.Deadline` and not `StepError.PauseExpired`.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { PauseExpiryBound, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { isRunBound } from "../../src/flow/runtime/pause-expiry-failure.js";

const AT = new Date("2026-01-01T00:10:00.000Z");
const EARLIER = new Date("2026-01-01T00:05:00.000Z");
const LATER = new Date("2026-01-01T00:20:00.000Z");

/** A pause that was extended to the very deadline it was made under: the store records its bound as `Pause`. */
const extended = (changes: Partial<PauseRecord> = {}): PauseRecord =>
  ({
    expiryBound: PauseExpiryBound.Pause,
    expiresAt: AT,
    boundAt: AT,
    askedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...changes,
  }) as never;

describe("#1366: a pause extended up to the deadline it was made under", () => {
  it("is the run's when the run's deadline ties with the pause's", () => {
    expect(isRunBound(extended(), AT.toISOString())).toBe(true);
  });

  it("is the run's when the run's deadline is earlier than the pause's", () => {
    expect(isRunBound(extended(), EARLIER.toISOString())).toBe(true);
  });

  it("is the pause's own when the run's deadline is later than the pause's", () => {
    expect(isRunBound(extended(), LATER.toISOString())).toBe(false);
  });

  it("is the pause's own when the run has no deadline", () => {
    expect(isRunBound(extended(), undefined)).toBe(false);
  });
});

describe("#1366: a pause with another bound", () => {
  it("recorded as the run's is the run's whatever the run's deadline says", () => {
    const pause = extended({ expiryBound: PauseExpiryBound.RunDeadline });

    expect(isRunBound(pause, LATER.toISOString())).toBe(true);
    expect(isRunBound(pause, undefined)).toBe(true);
  });

  it("recorded as the pause's, not at its bound, or as a quorum's, is never the run's", () => {
    expect(isRunBound(extended({ boundAt: LATER }), AT.toISOString())).toBe(false);
    expect(isRunBound(extended({ expiryBound: PauseExpiryBound.Quorum }), AT.toISOString())).toBe(false);
  });
});
