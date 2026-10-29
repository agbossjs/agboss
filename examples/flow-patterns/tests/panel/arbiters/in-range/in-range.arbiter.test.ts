import { expect, it } from "vitest";
import { testArbiter } from "@agboss/core/testing";
import { HireScoreAgent } from "../../../../src/panel/agents/hire-score/hire-score.agent.js";
import { SkillsScoreAgent } from "../../../../src/panel/agents/skills-score/skills-score.agent.js";
import { InRangeArbiter } from "../../../../src/panel/arbiters/in-range/in-range.arbiter.js";

it("testArbiter: the agent and its answer", async () => {
  const runArbiter = testArbiter(InRangeArbiter);

  expect((await runArbiter(SkillsScoreAgent, { score: 8, reason: "senior" })).output).toBe(true);
  expect((await runArbiter(HireScoreAgent, { score: 12, reason: "too keen" })).output).toBe(false);
});
