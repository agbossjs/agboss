/** #262 PR 3 (S89, #279): `testArbiter` — whether one answer counts, by code or by model. */
import { describe, expect, it } from "vitest";
import { ArbiterError } from "../../../src/index.js";
import { decideWith, testArbiter } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import {
  InRangeArbiter,
  PanelModelArbiter,
  resetPanel,
  RisksPanelAgent,
  SkillsPanelAgent,
} from "../../flow/fixtures/quorum-runtime-parts.js";

describe("testArbiter", () => {
  it("a code arbiter's @OnAnswer(Agent) method decides: in range counts, out of range does not", async () => {
    resetPanel();
    const runArbiter = testArbiter(InRangeArbiter);

    const counted = await runArbiter(SkillsPanelAgent, { score: 7 });
    const rejected = await runArbiter(RisksPanelAgent, { score: 12 });

    expect([counted.output, rejected.output]).toEqual([true, false]);
    expect(counted.spend.totalUsd).toBe(0);
  });

  it("a code arbiter that throws is ArbiterError, never a rejection", async () => {
    resetPanel();
    const runArbiter = testArbiter(InRangeArbiter);

    await expect(runArbiter(SkillsPanelAgent, { score: 13 })).rejects.toBeInstanceOf(ArbiterError);
  });

  it("a model arbiter asks its model with the agent's criterion; its cost is its spend", async () => {
    const runArbiter = testArbiter(PanelModelArbiter, {
      model: [decideWith({ counts: 0.9 }, { cost: usd(0.002) }), decideWith({ counts: 0.2 })],
    });

    const counted = await runArbiter(SkillsPanelAgent, { score: 7 });
    const rejected = await runArbiter(RisksPanelAgent, { score: 7 });

    expect([counted.output, rejected.output]).toEqual([true, false]);
    expect(counted.spend.byCaller).toEqual({ "arbiter:panel-model-arbiter": 0.002 });
  });

  it("a model arbiter without a script has no live model: ArbiterError", async () => {
    const runArbiter = testArbiter(PanelModelArbiter);

    await expect(runArbiter(SkillsPanelAgent, { score: 7 })).rejects.toThrow("has no script");
  });

  it("a class that is no @Arbiter is a setup error", () => {
    expect(() => testArbiter(SkillsPanelAgent)).toThrow("not an @Arbiter");
  });
});
