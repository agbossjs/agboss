/**
 * #262 PR 4 (S113, S115): a judge sees the agent's answer as its DTO — `@Judge({ reply })` +
 * `JudgeHandler<TReply>`; `reply` a DTO class, `oneOf(A, B)` or `PlainTextDto`; an agent whose
 * output its judge does not judge fails assembly with `[judge.wrong-reply]`; a failed verdict's
 * `reason` goes back to the agent for its retry.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { JudgeVerdict, QualityGateError } from "../../src/index.js";
import { replyWith, testJudge, testWith, type ModelRequest } from "../../src/testing/index.js";
import { offline } from "../components/fixture/deps-contract.workflow.js";
import { execute } from "../helpers/flow.js";
import { TaskStart } from "./fixtures/judged.workflow.js";
import {
  DecisionsJudge,
  DecisionsSummaryAgent,
  FairDecisionJudge,
  JobDto,
  JobReportDto,
  JobsScoutAgent,
  JobsSummaryAgent,
  ListJudgeApplication,
  ListJudgeWorkflow,
  PanelScreenerAgent,
  VariantListJudgeApplication,
  VariantListJudgeWorkflow,
  WrongValueReplyWorkflow,
  JobSearch,
  OfferDto,
  RefusalDto,
  RefusalWorkflowFinish,
  ReportWorkflowFinish,
  ScoutAgent,
  ScreenerAgent,
  TypedJudgeApplication,
  VariantJudgeApplication,
  WrongListReplyWorkflow,
  WrongReplyApplication,
  WrongReplyWorkflow,
  WrongReportReplyWorkflow,
} from "./fixtures/typed-judges.workflow.js";
import type { Class } from "../../src/components/injection.js";

/** Every text the model was sent in one request. */
const textsOf = (request: ModelRequest | undefined): string[] =>
  request?.kind === "chat"
    ? request.messages.map((line) =>
        typeof line.text === "string" ? line.text : JSON.stringify(line.text),
      )
    : [];

const JOB: JobDto = { title: "TS engineer", url: "https://jobs.example/acme/1" };

const REPORT: JobReportDto = { jobs: [JOB] };

describe("a DTO judge", () => {
  const test = testWith(TypedJudgeApplication);

  test("reads the answer as its validated DTO, not as text", async ({ app, mockLlm, mockOf }) => {
    mockOf(JobSearch).exists.mockResolvedValue(true);
    mockLlm(ScoutAgent).thenReturn(replyWith(JobReportDto, REPORT));

    const result = await execute(app, TaskStart, { text: "find a TS job" });

    expect(result).toFinishWith(ReportWorkflowFinish, REPORT);
    expect(mockOf(JobSearch).exists.mock.calls).toEqual([["https://jobs.example/acme/1"]]);
  });

  test("a failed verdict's reason reaches the agent's retry", async ({ app, mockLlm, mockOf }) => {
    mockOf(JobSearch).exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockLlm(ScoutAgent)
      .thenReturn(replyWith(JobReportDto, { jobs: [{ title: "Gone", url: "https://gone" }] }))
      .thenReturn(replyWith(JobReportDto, REPORT));

    const result = await execute(app, TaskStart, { text: "find a TS job" });

    expect(result).toFinishWith(ReportWorkflowFinish, REPORT);
    const [first, second] = mockLlm(ScoutAgent).requests;
    expect(textsOf(first).join("\n")).not.toContain("the first job does not exist");
    expect(textsOf(second).at(-1)).toContain(
      "[answer-grounded-judge] the first job does not exist",
    );
  });

  test("spent retries fail the run with every rejection's reason", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(JobSearch).exists.mockResolvedValue(false);
    mockLlm(ScoutAgent).thenReturnAlways(replyWith(JobReportDto, REPORT));

    const run = execute(app, TaskStart, { text: "find a TS job" });

    await expect(run).rejects.toBeInstanceOf(QualityGateError);
    await expect(run).rejects.toMatchObject({
      retries: 1,
      rejections: [{ judge: "answer-grounded-judge", reason: "the first job does not exist" }],
    });
  });
});

describe("a oneOf judge", () => {
  const test = testWith(VariantJudgeApplication);

  test("judges the variant the agent answered with", async ({ app, mockLlm }) => {
    mockLlm(ScreenerAgent)
      .thenReturn(replyWith(OfferDto, { salary: 0 }))
      .thenReturn(replyWith(RefusalDto, { why: "no TypeScript" }));

    const result = await execute(app, TaskStart, { text: "screen Ann" });

    expect(result).toFollowPath([TaskStart, ScreenerAgent, RefusalWorkflowFinish]);
    expect(result).toFinishWith(RefusalWorkflowFinish, { why: "no TypeScript" });
    const [, retry] = mockLlm(ScreenerAgent).requests;
    expect(textsOf(retry).at(-1)).toContain("[fair-decision-judge] an offer pays something");
  });

  it("on its own: either variant as a plain object, its verdict built by JudgeVerdict", async () => {
    const runJudge = testJudge(FairDecisionJudge);

    const offer = await runJudge({ reply: { salary: 10 }, task: "screen Ann", attempt: 0 });
    const refusal = await runJudge({ reply: { why: " " }, task: "screen Ann", attempt: 0 });

    expect(offer.output).toEqual(JudgeVerdict.passed({ metrics: { salary: 10 } }));
    expect(refusal.output).toEqual(JudgeVerdict.failed({ reason: "a refusal says why" }));
  });
});

describe("a list judge", () => {
  const test = testWith(ListJudgeApplication);

  test("reads the list of DTOs; its reason reaches the retry", async ({ app, mockLlm, mockOf }) => {
    mockOf(JobSearch).exists.mockImplementation((url: string) =>
      Promise.resolve(url !== "https://gone"),
    );
    mockLlm(JobsScoutAgent)
      .thenReturn(replyWith(JobDto, [JOB, { title: "Gone", url: "https://gone" }]))
      .thenReturn(replyWith(JobDto, [JOB]));
    mockLlm(JobsSummaryAgent).thenReturn(replyWith("One TS job."));

    const result = await execute(app, TaskStart, { text: "find TS jobs" });

    expect(result.output).toEqual({ text: "One TS job." });
    expect(mockOf(JobSearch).exists.mock.calls).toEqual([[JOB.url], ["https://gone"], [JOB.url]]);
    const [, retry] = mockLlm(JobsScoutAgent).requests;
    expect(textsOf(retry).at(-1)).toContain("[jobs-judge] every job must still be posted");
  });
});

describe("a list-of-oneOf judge", () => {
  const test = testWith(VariantListJudgeApplication);

  test("reads each variant's value, not its class tag", async ({ app, mockLlm }) => {
    mockLlm(PanelScreenerAgent)
      .thenReturn(replyWith(OfferDto, [{ salary: 1 }, { salary: 2 }]))
      .thenReturn(replyWith(RefusalDto, [{ why: "no TypeScript" }]));
    mockLlm(DecisionsSummaryAgent).thenReturn(replyWith("One refusal."));

    const result = await execute(app, TaskStart, { text: "screen the panel" });

    expect(result.output).toEqual({ text: "One refusal." });
    const [, retry] = mockLlm(PanelScreenerAgent).requests;
    expect(textsOf(retry).at(-1)).toContain("[decisions-judge] make at most one offer");
  });

  it("on its own: testJudge takes the list as plain objects", async () => {
    const { output } = await testJudge(DecisionsJudge)({
      reply: [{ salary: 1 }, { why: "no TypeScript" }],
      task: "screen the panel",
      attempt: 0,
    });

    expect(output).toEqual(JudgeVerdict.passed({ metrics: { offers: 1 } }));
  });
});

describe("[judge.wrong-reply]", () => {
  const wrongReplies = (workflow: Class): readonly string[] =>
    checkWorkflow(workflow)
      .errors.filter(({ code }) => code === "judge.wrong-reply")
      .map(({ message }) => message);

  it("a oneOf output whose variant its judge does not judge, and a text agent with a DTO judge", () => {
    expect(wrongReplies(WrongReplyWorkflow)).toEqual([
      expect.stringMatching(
        /offer-judged-screener-agent answers oneOf\(OfferDto, RefusalDto\), but its judge OfferOnlyJudge judges OfferDto — it does not judge RefusalDto/u,
      ),
      expect.stringMatching(
        /report-judged-writer-agent answers text \(no output: PlainTextDto\), but its judge AnswerGroundedJudge judges JobReportDto — it does not judge PlainTextDto/u,
      ),
    ]);
  });

  it("a DTO output with a text judge", () => {
    expect(wrongReplies(WrongReportReplyWorkflow)).toEqual([
      expect.stringMatching(
        /text-judged-scout-agent answers JobReportDto, but its judge TextJudge judges PlainTextDto — it does not judge JobReportDto/u,
      ),
    ]);
  });

  it("a list output with a judge of one value", () => {
    expect(wrongReplies(WrongListReplyWorkflow)).toEqual([
      expect.stringMatching(
        /list-judged-scout-agent answers listOf\(JobDto\), but its judge AnswerGroundedJudge judges JobReportDto — the agent answers a list: set @Judge\(\{ reply: listOf\(…\) \}\)/u,
      ),
    ]);
  });

  it("one value with a list judge", () => {
    expect(wrongReplies(WrongValueReplyWorkflow)).toEqual([
      expect.stringMatching(
        /list-judged-reporter-agent answers JobReportDto, but its judge JobsJudge judges listOf\(JobDto\) — the judge judges a list, but the agent answers one value/u,
      ),
    ]);
  });

  it("a list judge of the agent's list fits", () => {
    expect(wrongReplies(ListJudgeWorkflow)).toEqual([]);
    expect(wrongReplies(VariantListJudgeWorkflow)).toEqual([]);
  });

  it("fails the application's assembly before any model call", async () => {
    await expect(createApp(WrongReplyApplication, offline())).rejects.toThrow(
      /\[judge\.wrong-reply\]/u,
    );
  });
});
