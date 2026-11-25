/**
 * #946: a channel's own decision for a reassigned pause (`channelDecisionOf`): recorded as the
 * channel's answer, a pause already closed is applied once (a no-op), and what the run did after
 * the decision — a hand-over, an end — is the run's own outcome, never a failed send.
 */
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelDecisionOf } from "../../src/app/channel-decision.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { PauseClosedReason, PauseResolution } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const recorded = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/app/resume.js", () => ({ recordedAnswer: recorded.fn }));

const pause = pauseOf("p-1");
const closed = () =>
  new PauseError.Closed({
    pauseId: "p-1",
    tenantId: "default",
    reason: PauseClosedReason.Answered,
    closedAt: "2026-01-05T09:00:00.000Z",
  });

function decisionWith(options: { resumed?: () => Promise<unknown>; ended?: boolean }) {
  const resumed = vi.fn(options.resumed ?? (() => Promise.resolve(undefined)));
  const decide = channelDecisionOf({
    moves: { resumed },
    ownerOf: () => Promise.resolve("alice"),
    endedByRun: () => Promise.resolve(options.ended ?? false),
  } as never);
  return { decide, resumed };
}

beforeEach(() => {
  recorded.fn.mockReset();
  recorded.fn.mockResolvedValue({ pause, run: { turnId: "turn-1" } });
});

describe("#946: a channel's decision for a pause", () => {
  it("is recorded under the channel's name, whoever owns the thread, and moves the tree as the owner", async () => {
    const { decide, resumed } = decisionWith({});

    await decide(pause, { approved: true }, "refund-channel");

    expect(recorded.fn).toHaveBeenCalledWith(
      expect.anything(),
      pause,
      { pauseId: "p-1", decision: { approved: true } },
      { id: "refund-channel" },
      PauseResolution.Decided,
    );
    expect(resumed).toHaveBeenCalledWith(expect.anything(), { ownerId: "alice" });
  });

  it("a pause already closed is applied once: a no-op, the tree not moved", async () => {
    recorded.fn.mockRejectedValue(closed());
    const { decide, resumed } = decisionWith({});

    await expect(decide(pause, {}, "c")).resolves.toBeUndefined();
    expect(resumed).not.toHaveBeenCalled();
  });

  it("another failure of the record is the send's", async () => {
    recorded.fn.mockRejectedValue(new Error("the store is down"));

    await expect(decisionWith({}).decide(pause, {}, "c")).rejects.toThrow("the store is down");
  });

  it("a hand-over after the decision is the run's outcome, not a failed send", async () => {
    const { decide } = decisionWith({
      resumed: () => Promise.reject(new ExecutionLeaseLostError({ message: "lost" } as never)),
    });

    await expect(decide(pause, {}, "c")).resolves.toBeUndefined();
  });

  it("a run that ended after the decision is its own outcome; one that did not ends in the send's failure", async () => {
    const failing = () => Promise.reject(new Error("the step failed"));

    await expect(
      decisionWith({ resumed: failing, ended: true }).decide(pause, {}, "c"),
    ).resolves.toBeUndefined();
    await expect(
      decisionWith({ resumed: failing, ended: false }).decide(pause, {}, "c"),
    ).rejects.toThrow("the step failed");
  });
});
