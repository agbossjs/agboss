/**
 * #939: a step marks its answer `Taken` when it consumes it, so a `Taken` pause whose interrupt still
 * waits in the checkpoint is an answer a pass did not store: a recovery runs its step again with it
 * (and takes no decision to announce); a `Taken` pause decided at once, or one whose interrupt is gone,
 * is not.
 */
import { describe, expect, it } from "vitest";
import { treeResumeOf } from "../../src/run/resume-map.js";
import { PauseResolution, PauseStatus } from "../../src/infrastructure/pause-record.js";
import { APPROVED_BY_MANAGER, pauseOf } from "../../src/testing/contracts/paused-execution-data.js";

const waiting = (pauseId: string) => ({ interruptId: `i-${pauseId}`, pauseId, via: [] });
const taken = (pauseId: string, resolution: PauseResolution) => ({
  ...pauseOf(pauseId),
  status: PauseStatus.Taken,
  resolution,
  answer: APPROVED_BY_MANAGER,
});

describe("#939: treeResumeOf and a Taken pause", () => {
  it("a Taken pause whose interrupt still waits is resumed again, taking no decision", () => {
    const resume = treeResumeOf([waiting("p-1")], [taken("p-1", PauseResolution.Replied)]);

    expect(resume?.values).toEqual({ "i-p-1": "p-1" });
    expect(resume?.pauseIds).toEqual(["p-1"]);
    expect(resume?.taken).toEqual([]);
    expect(resume?.decisions).toEqual([]);
  });

  it("one decided at once never waits at an interrupt: not resumed", () => {
    expect(treeResumeOf([waiting("p-1")], [taken("p-1", PauseResolution.Decided)])).toBeUndefined();
  });

  it("one a drain's earlier pass took (its interrupt listed until the superstep ends) is not taken twice", () => {
    expect(
      treeResumeOf([waiting("p-1")], [taken("p-1", PauseResolution.Replied)], new Set(["p-1"])),
    ).toBeUndefined();
  });

  it("a Resolved one is still taken by the pass, with its decision", () => {
    const resolved = { ...taken("p-2", PauseResolution.Replied), status: PauseStatus.Resolved };

    const resume = treeResumeOf([waiting("p-2")], [resolved]);

    expect(resume?.taken).toEqual([resolved]);
    expect(resume?.decisions).toEqual([{ approved: true }]);
  });
});
