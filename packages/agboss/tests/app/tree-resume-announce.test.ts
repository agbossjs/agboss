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
});

function observed() {
  const onExecutionResume = vi.fn(() => Promise.resolve());
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
