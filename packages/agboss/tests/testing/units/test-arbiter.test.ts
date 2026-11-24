/** #262 PR 3 (S89, #279): `testUnit` — whether one answer counts, by code or by model. */
import { describe, expect, it } from "vitest";
import { ArbiterError } from "../../../src/index.js";
import { decideWith, testUnit } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { LiveArbiterModel } from "../../../src/flow/runtime/launch/arbiter-live.js";
import {
  HybridPanelArbiter,
  InRangeArbiter,
  PanelModelArbiter,
  HirePanelAgent,
  resetPanel,
  RisksPanelAgent,
  SkillsPanelAgent,
} from "../../flow/fixtures/quorum-runtime-parts.js";

describe("testUnit", () => {
  it("a code arbiter's @Arbitrate(Target) method decides: in range counts, out of range does not", async () => {
    resetPanel();
    const runArbiter = testUnit(InRangeArbiter);

    const counted = await runArbiter(SkillsPanelAgent, { score: 7 });
    const rejected = await runArbiter(RisksPanelAgent, { score: 12 });

    expect([counted.output, rejected.output]).toEqual([true, false]);
    expect(counted.spend.totalUsd).toBe(0);
  });

  it("a code arbiter that throws is ArbiterError, never a rejection", async () => {
    resetPanel();
    const runArbiter = testUnit(InRangeArbiter);

    await expect(runArbiter(SkillsPanelAgent, { score: 13 })).rejects.toBeInstanceOf(ArbiterError);
  });

  it("a model arbiter asks its model with the agent's criterion; its cost is its spend", async () => {
    const runArbiter = testUnit(PanelModelArbiter, {
      model: [decideWith({ counts: 0.9 }, { cost: usd(0.002) }), decideWith({ counts: 0.2 })],
    });

    const counted = await runArbiter(SkillsPanelAgent, { score: 7 });
    const rejected = await runArbiter(RisksPanelAgent, { score: 7 });

    expect([counted.output, rejected.output]).toEqual([true, false]);
    expect(counted.spend.byCaller).toEqual({ "arbiter:panel-model-arbiter": 0.002 });
  });

  it("a model arbiter without a script has no live model: ArbiterError", async () => {
    const runArbiter = testUnit(PanelModelArbiter);

    await expect(runArbiter(SkillsPanelAgent, { score: 7 })).rejects.toThrow("has no script");
  });

  it("a hybrid arbiter decides a clear score by code at $0 and asks its model for a borderline one (#1283)", async () => {
    resetPanel();
    const runArbiter = testUnit(HybridPanelArbiter, {
      model: [
        decideWith({ acceptable: 0.9 }, { cost: usd(0.002) }),
        decideWith({ acceptable: 0.2 }),
      ],
    });

    const sure = await runArbiter(SkillsPanelAgent, { score: 9 });
    const unsure = await runArbiter(RisksPanelAgent, { score: 6 });
    const doubted = await runArbiter(SkillsPanelAgent, { score: 7 });

    expect([sure.output, unsure.output, doubted.output]).toEqual([true, true, false]);
    expect(sure.spend.totalUsd).toBe(0);
    expect(unsure.spend.byCaller).toEqual({ "arbiter:hybrid-panel-arbiter": 0.002 });
  });

  it("a hybrid arbiter that fails after its model call carries that spend in its ArbiterError (#1399)", async () => {
    resetPanel();
    const runArbiter = testUnit(HybridPanelArbiter, {
      model: [decideWith({ acceptable: 0.9 }, { cost: usd(0.002) })],
    });

    const failure = await runArbiter(HirePanelAgent, { score: 5 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArbiterError);
    expect((failure as ArbiterError).usage.map((record) => Number(record.costUsd))).toEqual([
      0.002,
    ]);
  });

  it("the injected ArbiterModel outside an @Arbitrate method names the mistake", () => {
    const outside = new LiveArbiterModel("a-arbiter");

    expect(() => outside.model).toThrow("[arbiter.model-outside-arbiter]");
  });

  it("a class that is no @Arbiter is a setup error", () => {
    expect(() => testUnit(SkillsPanelAgent)).toThrow("not a component it runs");
  });
});
