import { expect, it } from "vitest";
import { decideWith, testUnit } from "@agboss/core/testing";
import { HireScoreAgent } from "../../../../src/panel/agents/hire-score/hire-score.agent.js";
import { SkillsScoreAgent } from "../../../../src/panel/agents/skills-score/skills-score.agent.js";
import { PanelScoreArbiter } from "../../../../src/panel/arbiters/panel-score/panel-score.arbiter.js";

it("testUnit: a score out of range is rejected by code, a reason is judged by the model", async () => {
  const runArbiter = testUnit(PanelScoreArbiter, {
    model: [decideWith({ counts: 0.9 }), decideWith({ counts: 0.2 })],
  });

  const outOfRange = await runArbiter(HireScoreAgent, { score: 12, reason: "too keen" });
  const reasoned = await runArbiter(SkillsScoreAgent, { score: 8, reason: "senior in Go" });
  const vague = await runArbiter(SkillsScoreAgent, { score: 8, reason: "fine" });

  expect([outOfRange.output, reasoned.output, vague.output]).toEqual([false, true, false]);
  expect(outOfRange.spend.totalUsd).toBe(0);
});
