/**
 * #262 PR 3 (S55, S62): `testJudge` — a judge on its own: its injected `JudgeModel` is its own
 * model answering by script (`decideWith` on a decision model, `replyWith` on a chat model).
 * PR 4 (S115): its `reply` is a plain object of the judge's `reply` DTO, typed by the judge.
 */
import { describe, expect, it } from "vitest";
import { Injectable, JudgeVerdict, ModelKindError } from "../../../src/index.js";
import {
  decideWith,
  failWith,
  ModelFailure,
  override,
  replyWith,
  testJudge,
} from "../../../src/testing/index.js";
import { PlainTextDto } from "../../../src/dto/index.js";
import { usd } from "../../../src/units/index.js";
import {
  AnswerGroundedJudge,
  JobReportDto,
  JobSearch,
} from "../../judges/fixtures/typed-judges.workflow.js";
import { GroundedJudge, ToneJudge } from "../fixtures/units.js";

const input = {
  variant: PlainTextDto,
  task: "Find TS jobs",
  reply: { text: "Acme hires TS engineers [acme.example]" },
  attempt: 0,
};

/** No job is posted any more. */
@Injectable()
class NoJobsSearch extends JobSearch {
  override exists(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe("testJudge", () => {
  it("a decision judge passes on its scripted decision; the call's cost is its spend", async () => {
    const runJudge = testJudge(GroundedJudge, {
      model: decideWith({ grounded: 0.9 }, { cost: usd(0.003) }),
    });

    const { output, spend } = await runJudge(input);

    expect(output).toEqual(JudgeVerdict.passed());
    expect(spend.byCaller).toEqual({ "judge:grounded-judge": 0.003 });
  });

  it("and fails with its reason when the decision says no", async () => {
    const runJudge = testJudge(GroundedJudge, { model: decideWith({ grounded: 0.1 }) });

    const { output } = await runJudge(input);

    expect(output).toEqual(JudgeVerdict.failed({ reason: "cite the source of every claim" }));
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

  it("a DTO judge takes its reply as a plain object of its DTO, typed by the judge", async () => {
    const runJudge = testJudge(AnswerGroundedJudge, {
      overrides: [override(JobSearch, NoJobsSearch)],
    });
    const reply = { jobs: [{ title: "TS engineer", url: "https://jobs.example/1" }] };

    const { output } = await runJudge({
      variant: JobReportDto,
      reply,
      task: "Find TS jobs",
      attempt: 1,
    });

    expect(output).toEqual(JudgeVerdict.failed({ reason: "the first job does not exist" }));
  });

  it("a reply of another shape does not compile", async () => {
    const runReport = testJudge(AnswerGroundedJudge);
    const runText = testJudge(ToneJudge, { model: replyWith("PASS") });

    const task = { variant: JobReportDto, task: "t", attempt: 0 } as const;
    // @ts-expect-error -- AnswerGroundedJudge judges a JobReportDto, not text
    const wrong = runReport({ reply: { text: "jobs" }, ...task });
    // @ts-expect-error -- ToneJudge judges a PlainTextDto: its reply is { text }, never a string
    const text = runText({ variant: PlainTextDto, reply: "PASS", task: "t", attempt: 0 });

    await expect(wrong).rejects.toThrow(TypeError);
    await expect(text).resolves.toMatchObject({ output: { passed: true } });
  });
});
