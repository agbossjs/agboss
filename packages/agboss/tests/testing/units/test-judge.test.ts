/**
 * #262 PR 3 (S55, S62): `testJudge` — a judge on its own: its injected `JudgeModel` is its own
 * model answering by script (`decideWith` on a decision model, `replyWith` on a chat model).
 */
import { describe, expect, it } from "vitest";
import { ModelKindError } from "../../../src/index.js";
import {
  decideWith,
  failWith,
  ModelFailure,
  replyWith,
  testJudge,
} from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { GroundedJudge, ToneJudge } from "../fixtures/units.js";

const input = { task: "Find TS jobs", reply: "Acme hires TS engineers [acme.example]", attempt: 0 };

describe("testJudge", () => {
  it("a decision judge passes on its scripted decision; the call's cost is its spend", async () => {
    const runJudge = testJudge(GroundedJudge, {
      model: decideWith({ grounded: 0.9 }, { cost: usd(0.003) }),
    });

    const { output, spend } = await runJudge(input);

    expect(output).toEqual({ passed: true });
    expect(spend.byCaller).toEqual({ "judge:grounded-judge": 0.003 });
  });

  it("and fails with its feedback when the decision says no", async () => {
    const runJudge = testJudge(GroundedJudge, { model: decideWith({ grounded: 0.1 }) });

    const { output } = await runJudge(input);

    expect(output).toEqual({ passed: false, feedback: "cite the source of every claim" });
  });

  it("a chat judge reads its model's reply", async () => {
    const runJudge = testJudge(ToneJudge, { model: [replyWith("PASS"), replyWith("FAIL")] });

    const first = await runJudge(input);
    const second = await runJudge(input);

    expect([first.output.passed, second.output.passed]).toEqual([true, false]);
  });

  it("a failed model call rejects the judge", async () => {
    const runJudge = testJudge(ToneJudge, { model: failWith(ModelFailure.Timeout) });

    await expect(runJudge(input)).rejects.toThrow();
  });

  it("the wrong call for its model's kind is ModelKindError, as at run time", async () => {
    // GroundedJudge decides; scripted as a chat reply it never gets one
    const runJudge = testJudge(GroundedJudge, { model: replyWith("PASS") });

    await expect(runJudge(input)).rejects.toThrow("decides on typesafe/jev-1.13");
    expect(ModelKindError.name).toBe("ModelKindError");
  });

  it("a judge with no script has no live model to call", async () => {
    const runJudge = testJudge(GroundedJudge);

    await expect(runJudge(input)).rejects.toThrow("has no script");
  });
});
