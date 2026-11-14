/**
 * #941 (V3.8): what a pass that takes an expiry is made of — a decision the channel decided on
 * expiry is read with its own reason (`Expired`), a reply with `Answered`, in the same order as the
 * decisions; a pause the expiry closed without an answer (`Cancelled / Expired`) is taken (its step
 * fails) with no decision, and `hasUnansweredExpiry` says so; a withdrawal is neither.
 */
import { describe, expect, it } from "vitest";
import { ResumeReason } from "../../src/core/observability.js";
import { treeResumeOf } from "../../src/run/resume-map.js";
import { PauseResolution, PauseStatus } from "../../src/infrastructure/pause-record.js";
import { APPROVED_BY_MANAGER, pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const waiting = (pauseId: string) => ({ interruptId: `i-${pauseId}`, pauseId, via: [] });
const closed = (pauseId: string, status: PauseStatus, resolution: PauseResolution) => ({
  ...pauseOf(pauseId),
  status,
  resolution,
  answer: APPROVED_BY_MANAGER,
});

describe("#941: treeResumeOf and an expiry", () => {
  it("a reply and a decided expiry: decisions in order, each with its reason", () => {
    const resume = treeResumeOf(
      [waiting("p-1"), waiting("p-2")],
      [
        closed("p-1", PauseStatus.Resolved, PauseResolution.Replied),
        closed("p-2", PauseStatus.Resolved, PauseResolution.DecidedOnExpiry),
      ],
    );

    expect(resume?.reasons).toEqual([ResumeReason.Answered, ResumeReason.Expired]);
    expect(resume?.decisions).toHaveLength(2);
    expect(resume?.hasUnansweredExpiry).toBe(false);
  });

  it("an expiry that failed the step: taken with no decision, hasUnansweredExpiry", () => {
    const resume = treeResumeOf(
      [waiting("p-1")],
      [closed("p-1", PauseStatus.Cancelled, PauseResolution.Expired)],
    );

    expect(resume?.values).toEqual({ "i-p-1": "p-1" });
    expect(resume?.decisions).toEqual([]);
    expect(resume?.reasons).toEqual([]);
    expect(resume?.hasUnansweredExpiry).toBe(true);
  });

  it("a withdrawal is taken with no decision and is no expiry", () => {
    const resume = treeResumeOf(
      [waiting("p-1")],
      [closed("p-1", PauseStatus.Cancelled, PauseResolution.Withdrawn)],
    );

    expect(resume?.hasUnansweredExpiry).toBe(false);
    expect(resume?.reasons).toEqual([]);
  });
});
