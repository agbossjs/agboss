import { describe, expect, it } from "vitest";
import { answerMethodsOf, arbiterOf, isCodeArbiter } from "../../../src/flow/decorators/arbiter.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { ScoreAAgent, ScoreBAgent, ScoreCAgent } from "../fixtures/quorum-agents.js";
import {
  GoodScoreArbiter,
  QuickScoreArbiter,
  ValidScoreArbiter,
} from "../fixtures/quorum.fixture.js";

/** #279 — what `@Arbiter` and `@OnAnswer(Agent)` record. */

describe("#279: @Arbiter records its options, @OnAnswer its methods", () => {
  it("a model arbiter: its options as written, no methods", () => {
    const declared = arbiterOf(ValidScoreArbiter);
    expect(declared?.options).toMatchObject({
      name: "valid-score-arbiter",
      decidedBy: DecidedBy.Model,
      model: "typesafe/jev-1.13",
    });
    expect(declared?.source).toMatch(/quorum\.fixture\.ts$/);
    expect(declared !== undefined && isCodeArbiter(declared.options)).toBe(false);
    expect(answerMethodsOf(ValidScoreArbiter)).toEqual([]);
  });

  it("a code arbiter: one method per agent, in declaration order, each class its own", () => {
    expect(answerMethodsOf(QuickScoreArbiter)).toEqual([
      { method: "fromScoreA", agent: ScoreAAgent },
      { method: "fromScoreB", agent: ScoreBAgent },
      { method: "fromScoreC", agent: ScoreCAgent },
    ]);
    expect(answerMethodsOf(GoodScoreArbiter)).toHaveLength(1);
    const declared = arbiterOf(QuickScoreArbiter);
    expect(declared !== undefined && isCodeArbiter(declared.options)).toBe(true);
  });

  it("an undecorated class has no declaration and no methods", () => {
    class PlainArbiter {
      readonly note = "no decorator";
    }
    expect(arbiterOf(PlainArbiter)).toBeUndefined();
    expect(answerMethodsOf(PlainArbiter)).toEqual([]);
  });
});
