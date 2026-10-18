import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Arbiter, OnAnswer } from "../../../src/flow/decorators/arbiter.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import { CompanyDto } from "../fixtures/data-dtos.js";
import { WorkflowStartTextDto } from "../fixtures/dtos.js";
import { CompanyCheckDto } from "../fixtures/launch-dtos.js";
import {
  AuditorAgent,
  BoardSearchAgent,
  CompanySearchWorkflowStart,
  CompanyShortlistAgent,
  CompanyShortlistWorkflowFinish,
  CompanyVetAgent,
  CultureScoreAgent,
  DealCriticAgent,
  DealWorkflowStart,
  FitReviewWorkflowStart,
  FitSummaryAgent,
  FitSummaryWorkflowFinish,
  FullReviewAgent,
  LegalAgent,
  QuickRejectWorkflowFinish,
  DueDiligenceReportWorkflowFinish,
  SalaryFitAgent,
  ScoreAAgent,
  ScoreBAgent,
  ScoreCAgent,
  SkillsScoreAgent,
  FastScreenAgent,
} from "../fixtures/quorum-agents.js";
import {
  CandidateDto,
  CompanyShortlistDto,
  CultureScoreDto,
  DealCritiqueDto,
  DealDto,
  DueDiligenceReportDto,
  FastScreenDto,
  FitSummaryDto,
  LegalReviewDto,
  SalaryFitDto,
  ScoreDto,
  SkillsScoreDto,
} from "../fixtures/quorum-dtos.js";
import {
  CandidateReviewWorkflow,
  CompanySearchWorkflow,
  ConvincingReasonArbiter,
  DueDiligenceArbiter,
  DueDiligenceWorkflow,
  FitReviewWorkflow,
  GoodScoreArbiter,
  ValidScoreArbiter,
} from "../fixtures/quorum.fixture.js";
import { agent, group, start } from "../fixtures/paths.js";

/** #279 PR 1 — quorums in the analyser: impossible quorums, what `.returns` may promise, arbiters. */

type Flow = WorkflowOptions["flow"];

let count = 0;
function workflowWith(flow: Flow): abstract new () => unknown {
  count += 1;
  @Workflow({ name: `quorum-case-${String(count)}-workflow`, version: "1.0.0", flow, maxSteps: 60 })
  class QuorumCaseWorkflow {}
  return QuorumCaseWorkflow;
}

/** The violations of a flow, messages without the (numbered) workflow's name. */
const errorsOf = (flow: Flow) =>
  checkWorkflow(workflowWith(flow)).errors.map(({ code, message }) => ({
    code,
    message: message.replace(/^quorum-case-\d+-workflow: /, ""),
  }));
const codesOf = (flow: Flow): readonly string[] => errorsOf(flow).map((found) => found.code);

@Agent({
  name: "skills-reader-agent",
  description: "Needs the skills score",
  prompt: "Read.",
  model: "moonshotai/kimi-k2.6",
  input: {
    skills: SkillsScoreDto,
    culture: optional(CultureScoreDto),
    salary: optional(SalaryFitDto),
  },
  output: FitSummaryDto,
})
class SkillsReaderAgent {}

/** The fit launch, its quorum and the values it names. */
const fitLaunch = () =>
  start(FitReviewWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(SkillsScoreAgent, CultureScoreAgent, SalaryFitAgent);
const fitValues = (joined: ReturnType<typeof fitLaunch>, skills: unknown) =>
  joined.returns(skills).returns(optional(CultureScoreDto)).returns(optional(SalaryFitDto));

const searched = () =>
  start(CompanySearchWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(BoardSearchAgent)
    .returns(listOf(CompanyDto))
    .toParallelAgents(CompanyVetAgent, { maxItems: 50 });
const shortlisted = (joined: ReturnType<typeof searched>) =>
  joined
    .returns(listOf(CompanyCheckDto))
    .toAgent(CompanyShortlistAgent)
    .returns(CompanyShortlistDto)
    .toFinish(CompanyShortlistWorkflowFinish);

const dealLaunch = () =>
  start(DealWorkflowStart)
    .returns(DealDto)
    .toParallelAgents(LegalAgent, DealCriticAgent, DealCriticAgent, FastScreenAgent);
const fastGroup = () =>
  group(FastScreenAgent).returns(FastScreenDto).toFinish(QuickRejectWorkflowFinish);
const reviewPath = () =>
  agent(FullReviewAgent).returns(DueDiligenceReportDto).toFinish(DueDiligenceReportWorkflowFinish);

describe("#279: the issue's quorums pass the analyser", () => {
  it.each([
    CandidateReviewWorkflow,
    FitReviewWorkflow,
    CompanySearchWorkflow,
    DueDiligenceWorkflow,
  ])("%o has no violation", (workflow) => {
    expect(checkWorkflow(workflow).errors).toEqual([]);
  });
});

describe("#279 AC14: what .returns(…) may promise after .joinQuorum({ min })", () => {
  it("quorum-return-not-optional on the quorum itself, not later in a consumer", () => {
    const flow = [
      fitValues(fitLaunch().joinQuorum({ min: 2 }), SkillsScoreDto)
        .toAgent(SkillsReaderAgent)
        .returns(FitSummaryDto)
        .toFinish(FitSummaryWorkflowFinish),
    ];
    expect(errorsOf(flow)).toEqual([
      {
        code: "flow.quorum-return-not-optional",
        message:
          "fit-review-workflow-start → toParallelAgents(skills-score-agent, culture-score-agent, salary-fit-agent): .joinQuorum({ min: 2 }) may leave skills-score-agent out of the quorum — write .returns(optional(SkillsScoreDto)), not .returns(SkillsScoreDto) (or min: 3 to count every agent)",
      },
    ]);
  });

  it("with min equal to the agents launched a required value is allowed", () => {
    const flow = [
      fitLaunch()
        .joinQuorum({ min: 3 })
        .returns(SkillsScoreDto)
        .returns(CultureScoreDto)
        .returns(SalaryFitDto)
        .toAgent(SkillsReaderAgent)
        .returns(FitSummaryDto)
        .toFinish(FitSummaryWorkflowFinish),
    ];
    expect(codesOf(flow)).toEqual([]);
  });
});

describe("#279 AC8: only counted answers enter the scope — what a consumer may require", () => {
  it("a required field whose producer may be left out: missing-on-path with the fix", () => {
    const flow = [
      fitValues(fitLaunch().joinQuorum({ min: 2 }), optional(SkillsScoreDto))
        .toAgent(SkillsReaderAgent)
        .returns(FitSummaryDto)
        .toFinish(FitSummaryWorkflowFinish),
    ];
    expect(errorsOf(flow)).toEqual([
      {
        code: "input.missing-on-path",
        message:
          "skills-reader-agent.skills (SkillsScoreDto) is not produced on the path fit-review-workflow-start → skills-reader-agent (skills-score-agent may be left out of the quorum) — make it optional(SkillsScoreDto) or listOf(SkillsScoreDto)",
      },
    ]);
  });

  it("a counted answer nobody reads is flow.unused-output", () => {
    const flow = [
      start(FitReviewWorkflowStart)
        .returns(CandidateDto)
        .toParallelAgents(ScoreAAgent, ScoreBAgent, SkillsScoreAgent)
        .joinQuorum({ min: 2 })
        .returns(listOf(ScoreDto))
        .returns(optional(SkillsScoreDto))
        .toAgent(FitSummaryAgent)
        .returns(FitSummaryDto)
        .toFinish(FitSummaryWorkflowFinish),
    ];
    expect(codesOf(flow)).toContain("flow.unused-output");
  });
});

describe("#279: an impossible quorum fails assembly", () => {
  it("min above the agents launched", () => {
    const flow = [
      fitValues(fitLaunch().joinQuorum({ min: 4 }), optional(SkillsScoreDto))
        .toAgent(FitSummaryAgent)
        .returns(FitSummaryDto)
        .toFinish(FitSummaryWorkflowFinish),
    ];
    expect(errorsOf(flow)).toEqual([
      {
        code: "flow.quorum-impossible",
        message:
          "fit-review-workflow-start → toParallelAgents(skills-score-agent, culture-score-agent, salary-fit-agent): .joinQuorum({ min: 4 }) needs 4 counted answers, but the launch runs 3 agents — lower min, or launch more",
      },
    ]);
  });

  it("per item: min above maxItems", () => {
    const flow = [shortlisted(searched().joinQuorum({ min: 60 }))];
    expect(codesOf(flow)).toEqual(["flow.quorum-impossible"]);
  });

  it("a group listing an agent not launched, or more copies than launched", () => {
    const flow = [
      dealLaunch().joinQuorumGroups(
        group(DealCriticAgent, DealCriticAgent, DealCriticAgent)
          .returns(listOf(DealCritiqueDto))
          .toAgent(FullReviewAgent),
        group(AuditorAgent).returns(FastScreenDto).toFinish(QuickRejectWorkflowFinish),
        fastGroup(),
      ),
      reviewPath(),
    ];
    const impossible = errorsOf(flow).filter((found) => found.code === "flow.quorum-impossible");
    expect(impossible.map((found) => found.message.replace(/^.*: group/, "group"))).toEqual([
      "group(auditor-agent) lists auditor-agent, which the launch does not run — it can never complete; list agents of the launch",
      "group(deal-critic-agent, deal-critic-agent, deal-critic-agent) needs 3 counted deal-critic-agent answers, but the launch runs 2 — it can never complete",
    ]);
  });
});

describe("#279 AC7 / AC13: groups continue their own paths, shapes from the launch", () => {
  it("a repeated class is listOf in a group that counts one copy", () => {
    const flow = [
      dealLaunch().joinQuorumGroups(
        group(LegalAgent, DealCriticAgent)
          .returns(LegalReviewDto)
          .returns(DealCritiqueDto)
          .toAgent(FullReviewAgent),
        fastGroup(),
      ),
      reviewPath(),
    ];
    expect(errorsOf(flow).filter((found) => found.code === "flow.returns-mismatch")).toEqual([
      {
        code: "flow.returns-mismatch",
        message:
          "the counted answers of deal-workflow-start → toParallelAgents(legal-agent, deal-critic-agent, deal-critic-agent, fast-screen-agent) group(legal-agent, deal-critic-agent) give LegalReviewDto, listOf(DealCritiqueDto) — write group(legal-agent, deal-critic-agent).returns(LegalReviewDto).returns(listOf(DealCritiqueDto)), not group(legal-agent, deal-critic-agent).returns(DealCritiqueDto).returns(LegalReviewDto)",
      },
    ]);
  });

  it("a group without a continuation leads nowhere", () => {
    const flow = [dealLaunch().joinQuorumGroups(group(FastScreenAgent).returns(FastScreenDto))];
    expect(codesOf(flow)).toContain("graph.dead-end");
  });

  it("a node reached from two groups is continued once — its own path", () => {
    const toReview = () =>
      group(DealCriticAgent, DealCriticAgent)
        .returns(listOf(DealCritiqueDto))
        .toAgent(FullReviewAgent)
        .returns(DueDiligenceReportDto)
        .toFinish(DueDiligenceReportWorkflowFinish);
    const flow = [
      dealLaunch().joinQuorumGroups(
        group(LegalAgent, DealCriticAgent)
          .returns(LegalReviewDto)
          .returns(listOf(DealCritiqueDto))
          .toAgent(FullReviewAgent)
          .returns(DueDiligenceReportDto)
          .toFinish(DueDiligenceReportWorkflowFinish),
        toReview(),
        fastGroup(),
      ),
    ];
    expect(codesOf(flow)).toContain("flow.continuation-twice");
  });
});

// ── arbiters ──

@Arbiter({
  name: "partial-score-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets its criterion.",
  criteria: [
    { agent: ScoreAAgent, prompt: "A score" },
    { agent: ScoreBAgent, prompt: "Risks" },
    { agent: ScoreBAgent, prompt: "Risks again" },
    { agent: LegalAgent, prompt: "Legal risks" },
  ],
})
class PartialScoreArbiter {}

@Arbiter({ name: "two-methods-arbiter", decidedBy: DecidedBy.Code })
class TwoMethodsArbiter {
  @OnAnswer(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return answer.score > 0;
  }

  @OnAnswer(ScoreAAgent)
  checkScoreA(answer: ScoreDto): boolean {
    return answer.score < 11;
  }

  @OnAnswer(ScoreBAgent)
  fromScoreB(answer: ScoreDto): boolean {
    return answer.score > 0;
  }
}

@Arbiter({
  name: "method-on-model-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Judge.",
  criteria: [
    { agent: ScoreAAgent, prompt: "A score" },
    { agent: ScoreBAgent, prompt: "Risks" },
    { agent: ScoreCAgent, prompt: "A verdict" },
  ],
})
class MethodOnModelArbiter {
  @OnAnswer(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return answer.score > 0;
  }
}

@Arbiter({
  name: "badly-named",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Judge.",
  criteria: [
    { agent: ScoreAAgent, prompt: "A score" },
    { agent: ScoreBAgent, prompt: "Risks" },
    { agent: ScoreCAgent, prompt: "A verdict" },
  ],
})
class BadlyNamedArbiter {}

class UndecoratedArbiter {
  readonly note = "no decorator";
}

const scored = (arbiter: unknown) => [
  start(FitReviewWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(ScoreAAgent, ScoreBAgent, ScoreCAgent)
    .acceptedBy(arbiter)
    .joinQuorum({ min: 2 })
    .returns(listOf(ScoreDto))
    .toAgent(FitSummaryAgent)
    .returns(FitSummaryDto)
    .toFinish(FitSummaryWorkflowFinish),
];

/** The arbiter violations of a launch of the three scores, messages without the workflow's name. */
const arbiterErrorsOf = (arbiter: unknown) =>
  errorsOf(scored(arbiter))
    .filter((found) => found.code.startsWith("arbiter.") || found.code === "name.kind-suffix")
    .map(({ code, message }) => ({ code, message }));

const LAUNCH =
  "fit-review-workflow-start → toParallelAgents(score-a-agent, score-b-agent, score-c-agent)";

describe("#279 AC5: a model arbiter covers every agent of its launch by a criterion", () => {
  it("unhandled agent, agent not in the launch, two criteria for one agent", () => {
    expect(arbiterErrorsOf(PartialScoreArbiter)).toEqual([
      {
        code: "arbiter.duplicate-agent",
        message:
          "partial-score-arbiter has 2 criteria for ScoreBAgent — one criterion per agent class",
      },
      {
        code: "arbiter.unhandled-agent",
        message: `partial-score-arbiter has no criterion for ScoreCAgent for this launch (${LAUNCH}) — add one — its prompt never stands in; an agent that needs no real check gets "Any non-empty answer"`,
      },
      {
        code: "arbiter.unknown-agent",
        message: `partial-score-arbiter has a criterion for LegalAgent, but ${LAUNCH} does not launch LegalAgent — remove it`,
      },
    ]);
  });

  it("a criterion covers every item of a per-item launch; a chain of a code and a model arbiter", () => {
    const flow = [
      shortlisted(
        searched()
          .acceptedBy(GoodScoreArbiter)
          .acceptedBy(ConvincingReasonArbiter)
          .joinQuorum({ min: 5 }),
      ),
    ];
    expect(codesOf(flow)).toEqual([]);
  });

  it("a criterion covers every copy of a repeated agent", () => {
    const flow = [
      dealLaunch()
        .acceptedBy(DueDiligenceArbiter)
        .joinQuorumGroups(
          group(LegalAgent, DealCriticAgent)
            .returns(LegalReviewDto)
            .returns(listOf(DealCritiqueDto))
            .toAgent(FullReviewAgent)
            .returns(DueDiligenceReportDto)
            .toFinish(DueDiligenceReportWorkflowFinish),
          fastGroup(),
        ),
    ];
    expect(codesOf(flow)).toEqual(["arbiter.unknown-agent"]); // the arbiter also judges auditor-agent
  });

  it("the arbiter must be decorated, and named -arbiter", () => {
    expect(arbiterErrorsOf(UndecoratedArbiter)).toEqual([
      {
        code: "arbiter.not-an-arbiter",
        message:
          ".acceptedBy(UndecoratedArbiter): UndecoratedArbiter has no @Arbiter decorator — decorate it with @Arbiter({ name, decidedBy, … })",
      },
    ]);
    expect(arbiterErrorsOf(BadlyNamedArbiter)).toEqual([
      {
        code: "name.kind-suffix",
        message: '"badly-named" on @Arbiter — name it "badly-named-arbiter"',
      },
    ]);
  });

  it("every arbiter of anyOf(…) and of a chain is checked; a good one adds nothing", () => {
    expect(arbiterErrorsOf(ValidScoreArbiter)).toEqual([]);
  });
});

describe("#279 AC6: a code arbiter has one @OnAnswer(Agent) method per agent", () => {
  it("unhandled agent, two methods for one class, a method's name", () => {
    expect(arbiterErrorsOf(TwoMethodsArbiter)).toHaveLength(3);
    expect(arbiterErrorsOf(TwoMethodsArbiter)).toEqual(
      expect.arrayContaining([
        {
          code: "arbiter.unhandled-agent",
          message: `two-methods-arbiter has no @OnAnswer(ScoreCAgent) method for this launch (${LAUNCH}) — add the method`,
        },
        {
          code: "arbiter.duplicate-agent",
          message:
            "two-methods-arbiter has 2 @OnAnswer(ScoreAAgent) methods (fromScoreA, checkScoreA) — one method per agent class; share a rule through a private method",
        },
        {
          code: "arbiter.method-name",
          message:
            "two-methods-arbiter.checkScoreA: the @OnAnswer(ScoreAAgent) method is named fromScoreA — rename it",
        },
      ]),
    );
  });

  it("@OnAnswer on a model arbiter is an assembly error", () => {
    expect(arbiterErrorsOf(MethodOnModelArbiter)).toEqual([
      {
        code: "arbiter.answer-method-on-model",
        message:
          "method-on-model-arbiter is decided by its model (DecidedBy.Model) — remove @OnAnswer from fromScoreA, or make it DecidedBy.Code",
      },
    ]);
  });
});
