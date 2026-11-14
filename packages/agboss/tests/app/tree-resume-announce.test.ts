/**
 * #939: a recovery announces itself once (`onExecutionResume`, `ResumeReason.Recovered`) whatever it
 * takes — no decision, a withdrawn pause, or only `Taken` answers a pass did not store (a step took
 * its answer, the pass failed after: the recovery runs the step again and has no decision to name).
 * A pass of another reason announces one event per decision, and none for a pass that only withdraws.
 */
import { describe, expect, it, vi } from "vitest";
import { ResumeReason } from "../../src/core/observability.js";
import { announceResume } from "../../src/app/tree-resume.js";
import type { TreeResume } from "../../src/run/resume-map.js";

const resumeOf = (decisions: readonly unknown[]): TreeResume => ({
  values: {},
  pauseIds: ["p-1"],
  taken: [],
  decisions,
  answeredBy: decisions.map(() => "manager-17"),
  reasons: decisions.map(() => ResumeReason.Answered),
  hasUnansweredExpiry: false,
});

function observed() {
  const onExecutionResume = vi.fn((_event: unknown) => Promise.resolve());
  const observer = { onExecutionResume };
  return { observer, calls: onExecutionResume.mock.calls };
}

describe("#939: announceResume", () => {
  it("a recovery with no resume: once", async () => {
    const { observer, calls } = observed();

    await announceResume(observer as never, {} as never, ResumeReason.Recovered, undefined);

    expect(calls).toHaveLength(1);
  });

  it("a recovery that takes only Taken answers a pass did not store (no decision): once, naming none", async () => {
    const { observer, calls } = observed();

    await announceResume(observer as never, {} as never, ResumeReason.Recovered, resumeOf([]));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      expect.objectContaining({ reason: ResumeReason.Recovered, decision: undefined }),
    ]);
  });

  it("a recovery that takes decisions: one event per decision", async () => {
    const { observer, calls } = observed();

    await announceResume(observer as never, {} as never, ResumeReason.Recovered, resumeOf([1, 2]));

    expect(calls).toHaveLength(2);
  });

  it("an answered pass that only withdraws announces nothing", async () => {
    const { observer, calls } = observed();

    await announceResume(observer as never, {} as never, ResumeReason.Answered, resumeOf([]));

    expect(calls).toHaveLength(0);
  });
});

describe("#941: announceResume and an expiry (V1)", () => {
  const withReasons = (overrides: Partial<TreeResume>): TreeResume => ({
    ...resumeOf([]),
    ...overrides,
  });

  it("an expiry pass that takes no decision (fail(), a run- or quorum-bound pause): once, Expired, naming none", async () => {
    const { observer, calls } = observed();

    await announceResume(
      observer as never,
      {} as never,
      ResumeReason.Expired,
      withReasons({ hasUnansweredExpiry: true }),
    );

    expect(calls).toEqual([
      [expect.objectContaining({ reason: ResumeReason.Expired, decision: undefined })],
    ]);
  });

  it("an expiry pass with no resume at all (the fallback): once", async () => {
    const { observer, calls } = observed();

    await announceResume(observer as never, {} as never, ResumeReason.Expired, undefined);

    expect(calls).toHaveLength(1);
  });

  it("a decided expiry is announced Expired with its decision, once", async () => {
    const { observer, calls } = observed();

    await announceResume(
      observer as never,
      {} as never,
      ResumeReason.Expired,
      withReasons({
        decisions: [{ ok: 1 }],
        answeredBy: [undefined],
        reasons: [ResumeReason.Expired],
      }),
    );

    expect(calls).toEqual([
      [expect.objectContaining({ reason: ResumeReason.Expired, decision: { ok: 1 } })],
    ]);
  });

  it("a pass that takes an answer and an expiry: the answer Answered, the expiry once, Expired", async () => {
    const { observer, calls } = observed();

    await announceResume(
      observer as never,
      {} as never,
      ResumeReason.Expired,
      withReasons({
        decisions: ["a"],
        answeredBy: ["manager-17"],
        reasons: [ResumeReason.Answered],
        hasUnansweredExpiry: true,
      }),
    );

    expect(
      calls.map(([event]) => [
        (event as { reason: string }).reason,
        (event as { decision: unknown }).decision,
      ]),
    ).toEqual([
      [ResumeReason.Answered, "a"],
      [ResumeReason.Expired, undefined],
    ]);
  });

  it("an answered pass that also takes an earlier expiry's failure: the answer, then Expired once", async () => {
    const { observer, calls } = observed();

    await announceResume(
      observer as never,
      {} as never,
      ResumeReason.Answered,
      withReasons({
        decisions: ["a"],
        answeredBy: ["m"],
        reasons: [ResumeReason.Answered],
        hasUnansweredExpiry: true,
      }),
    );

    expect(calls).toHaveLength(2);
  });

  it("a recovery keeps its own reason for what it takes, however it was decided", async () => {
    const { observer, calls } = observed();

    await announceResume(
      observer as never,
      {} as never,
      ResumeReason.Recovered,
      withReasons({ decisions: ["a"], answeredBy: ["m"], reasons: [ResumeReason.Expired] }),
    );

    expect(calls).toEqual([[expect.objectContaining({ reason: ResumeReason.Recovered })]]);
  });
});
