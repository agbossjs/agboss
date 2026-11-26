/**
 * #1307 (G3): a `Date` fact of an error is an ISO 8601 text in its `details` (what the record and the
 * audit keep), and the message names it the same way; an invalid `Date` is never a reason for an error
 * to throw while it is made.
 */
import { describe, expect, it } from "vitest";
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { StepError } from "../../src/core/error-families/step-errors.js";
import { PauseClosedReason, pauseKeyOf } from "../../src/infrastructure/pause-record.js";

const AT = new Date("2026-01-05T09:00:00.000Z");

describe("#1307: a Date fact of an error", () => {
  it("PauseError.Closed: closedAt is the Date given; details and message say the ISO text", () => {
    const error = new PauseError.Closed({
      pauseId: "p-1",
      tenantId: "acme",
      reason: PauseClosedReason.Answered,
      closedAt: AT,
    });

    expect(error.closedAt).toBe(AT);
    expect(error.details).toMatchObject({ closedAt: "2026-01-05T09:00:00.000Z" });
    expect(error.message).toBe(
      `pause ${pauseKeyOf("acme", "p-1")} is closed: answered at 2026-01-05T09:00:00.000Z`,
    );
    // the pause's id is a credential: in a field, never in details or message
    expect(JSON.stringify(error.details)).not.toContain("p-1");
  });

  it("PauseError.Closed without a closedAt says so, and keeps no detail of it", () => {
    const error = new PauseError.Closed({
      pauseId: "p-1",
      tenantId: "acme",
      reason: PauseClosedReason.Cancelled,
    });

    expect(error.closedAt).toBeUndefined();
    expect(error.details).not.toHaveProperty("closedAt");
    expect(error.message).toContain("at an unknown time");
  });

  it("a Date of no instant never makes the error throw: details and message show the fact", () => {
    const error = new PauseError.Closed({
      pauseId: "p-1",
      tenantId: "acme",
      reason: PauseClosedReason.Expired,
      closedAt: new Date(Number.NaN),
    });

    expect(error.details).toMatchObject({ closedAt: "an invalid time" });
    expect(error.message).toContain("at an invalid time");
  });

  it("StepError.PauseExpired: expiresAt is the Date given; details and message say the ISO text", () => {
    const error = new StepError.PauseExpired({ step: "ask", target: "desk", expiresAt: AT });

    expect(error.expiresAt).toBe(AT);
    expect(error.details).toMatchObject({ expiresAt: "2026-01-05T09:00:00.000Z" });
    expect(error.message).toBe("ask: its pause on desk expired at 2026-01-05T09:00:00.000Z");
  });

  it("StepError.PauseExpired with a Date of no instant: the message and details say so", () => {
    const error = new StepError.PauseExpired({
      step: "ask",
      target: "desk",
      expiresAt: new Date(Number.NaN),
    });

    expect(error.details).toMatchObject({ expiresAt: "an invalid time" });
    expect(error.message).toBe("ask: its pause on desk expired at an invalid time");
  });

  it("LimitError.Deadline: deadlineAt is the Date given; details and message say the ISO text (the same pause expiry reaches .onError with a Date either way)", () => {
    const error = new LimitError.Deadline({
      deadline: 30_000 as never,
      deadlineAt: AT,
      path: ["start"],
      spentUsd: 0 as never,
    });

    expect(error.deadlineAt).toBe(AT);
    expect(error.details).toMatchObject({ deadlineAt: "2026-01-05T09:00:00.000Z" });
    expect(error.message).toContain("(at 2026-01-05T09:00:00.000Z)");
  });
});
