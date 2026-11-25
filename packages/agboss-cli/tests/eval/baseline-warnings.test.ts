/**
 * #1328d: a `--baseline` run is warned of what the baseline ran on that it did not: its profile, its
 * models, and above all its judges — a judge that changed moves the yardstick.
 */
import { describe, expect, it } from "vitest";
import { ComponentKind } from "../../../agboss/src/flow/runtime/records.js";
import type { EvalModelUse, EvalRunReport } from "@agboss/core/eval";
import { environmentWarningsOf } from "../../src/eval/baseline.js";

const use = (component: string, model: string, provider = "openrouter"): EvalModelUse => ({
  component,
  kind: ComponentKind.Agent,
  model,
  provider,
});

const reportOf = (ran: Partial<EvalRunReport>): EvalRunReport => ({ ...ran }) as EvalRunReport;

describe("#1328d: what a baseline ran on", () => {
  it("says nothing when the profile, the models and the judges are the same", () => {
    const same = {
      profile: "prod",
      models: [use("desk-agent", "m1")],
      judges: [use("grounded-judge", "j1")],
    };

    expect(environmentWarningsOf(reportOf(same), reportOf(same))).toEqual([]);
  });

  it("names a judge that moved, a model that moved and a profile that changed", () => {
    const baseline = reportOf({
      profile: "prod",
      models: [use("desk-agent", "m1")],
      judges: [use("grounded-judge", "j1")],
    });
    const run = reportOf({
      profile: "economy",
      models: [use("desk-agent", "m2")],
      judges: [use("grounded-judge", "j1", "local")],
    });

    expect(environmentWarningsOf(baseline, run)).toEqual([
      "the baseline ran on profile prod, this run on economy",
      "model drift: desk-agent ran on openrouter/m1 in the baseline, on openrouter/m2 now",
      "judge drift: grounded-judge ran on openrouter/j1 in the baseline, on local/j1 now — a changed verdict may be the judge's, not the candidate's",
    ]);
  });

  it("a judge only the run has, or only the baseline had, is drift too; a baseline without judges says nothing of them", () => {
    const withJudge = reportOf({ judges: [use("grounded-judge", "j1")], models: [] });
    const without = reportOf({ judges: [], models: [] });
    const noRecord = reportOf({});

    expect(environmentWarningsOf(withJudge, without)).toHaveLength(1);
    expect(environmentWarningsOf(without, withJudge)).toHaveLength(1);
    expect(environmentWarningsOf(noRecord, withJudge)).toEqual([]);
  });
});
