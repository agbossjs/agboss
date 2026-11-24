import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Arbiter, Arbitrate } from "../../../src/flow/decorators/arbiter.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
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
  OpenDealRoomAction,
} from "../fixtures/quorum-agents.js";
import {
  CultureScoreDto,
  DealCritiqueDto,
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
import { onAgent, group, onStart, toAction, toAgent } from "../fixtures/paths.js";

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
  onStart(FitReviewWorkflowStart).toParallelAgents(
    SkillsScoreAgent,
    CultureScoreAgent,
    SalaryFitAgent,
  );
const searched = () =>
  onStart(CompanySearchWorkflowStart)
    .toAgent(BoardSearchAgent)
    .toParallelAgents(CompanyVetAgent, { maxItems: 50 });
const shortlisted = (joined: ReturnType<typeof searched>) =>
  joined.toAgent(CompanyShortlistAgent).toFinish(CompanyShortlistWorkflowFinish);

const dealLaunch = () =>
  onStart(DealWorkflowStart).toParallelAgents(
    LegalAgent,
    DealCriticAgent,
    DealCriticAgent,
    FastScreenAgent,
  );
const fastGroup = () => group(FastScreenAgent).toFinish(QuickRejectWorkflowFinish);
const reviewPath = () => onAgent(FullReviewAgent).toFinish(DueDiligenceReportWorkflowFinish);

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

describe("#279 AC14: what the counted answers give after .joinQuorum({ min })", () => {
  it("a consumer of a single answer the quorum may leave out is [input.missing-on-path]", () => {
    const flow = [
      fitLaunch()
        .joinQuorum({ min: 2 })
        .toAgent(SkillsReaderAgent)
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

  it("with min equal to the agents launched a required value is allowed", () => {
    const flow = [
      fitLaunch()
        .joinQuorum({ min: 3 })
        .toAgent(SkillsReaderAgent)
        .toFinish(FitSummaryWorkflowFinish),
    ];
    expect(codesOf(flow)).toEqual([]);
  });
});

describe("#279 AC8: only counted answers enter the scope — what a consumer may require", () => {
  it("a required field whose producer may be left out: missing-on-path with the fix", () => {
    const flow = [
      fitLaunch()
        .joinQuorum({ min: 2 })
        .toAgent(SkillsReaderAgent)
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
      onStart(FitReviewWorkflowStart)
        .toParallelAgents(ScoreAAgent, ScoreBAgent, SkillsScoreAgent)
        .joinQuorum({ min: 2 })
        .toAgent(FitSummaryAgent)
        .toFinish(FitSummaryWorkflowFinish),
    ];
    expect(codesOf(flow)).toContain("flow.unused-output");
  });
});

describe("#279: an impossible quorum fails assembly", () => {
  it("min above the agents launched", () => {
    const flow = [
      fitLaunch()
        .joinQuorum({ min: 4 })
        .toAgent(FitSummaryAgent)
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
        group(DealCriticAgent, DealCriticAgent, DealCriticAgent).toAgent(FullReviewAgent),
        group(AuditorAgent).toFinish(QuickRejectWorkflowFinish),
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
  it("a group without a continuation leads nowhere", () => {
    const flow = [dealLaunch().joinQuorumGroups(group(FastScreenAgent))];
    expect(codesOf(flow)).toContain("graph.dead-end");
  });

  it("a node reached from two groups is continued once — its own path", () => {
    const toReview = () =>
      group(DealCriticAgent, DealCriticAgent)
        .toAgent(FullReviewAgent)
        .toFinish(DueDiligenceReportWorkflowFinish);
    const flow = [
      dealLaunch().joinQuorumGroups(
        group(LegalAgent, DealCriticAgent)
          .toAgent(FullReviewAgent)
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
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets its criterion.",
  criteria: [
    { target: ScoreAAgent, prompt: "A score" },
    { target: ScoreBAgent, prompt: "Risks" },
    { target: ScoreBAgent, prompt: "Risks again" },
    { target: LegalAgent, prompt: "Legal risks" },
  ],
})
class PartialScoreArbiter {}

@Arbiter({ name: "two-methods-arbiter" })
class TwoMethodsArbiter {
  @Arbitrate(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return answer.score > 0;
  }

  @Arbitrate(ScoreAAgent)
  checkScoreA(answer: ScoreDto): boolean {
    return answer.score < 11;
  }

  @Arbitrate(ScoreBAgent)
  fromScoreB(answer: ScoreDto): boolean {
    return answer.score > 0;
  }
}

@Arbiter({ name: "one-method-arbiter" })
class OneMethodArbiter {
  @Arbitrate(ScoreAAgent, ScoreBAgent, ScoreCAgent)
  isMeaningful(answer: ScoreDto): boolean {
    return answer.score > 0;
  }
}

@Arbiter({
  name: "Badly_Named",
  model: "typesafe/jev-1.13",
  prompt: "Judge.",
  criteria: [
    { target: ScoreAAgent, prompt: "A score" },
    { target: ScoreBAgent, prompt: "Risks" },
    { target: ScoreCAgent, prompt: "A verdict" },
  ],
})
class BadlyNamedArbiter {}

class UndecoratedArbiter {
  readonly note = "no decorator";
}

const scored = (arbiter: unknown) => [
  onStart(FitReviewWorkflowStart)
    .toParallelAgents(ScoreAAgent, ScoreBAgent, ScoreCAgent)
    .arbitratedBy(arbiter)
    .joinQuorum({ min: 2 })
    .toAgent(FitSummaryAgent)
    .toFinish(FitSummaryWorkflowFinish),
];

/** The arbiter violations of a launch of the three scores, messages without the workflow's name. */
const arbiterErrorsOf = (arbiter: unknown) =>
  errorsOf(scored(arbiter))
    .filter((found) => found.code.startsWith("arbiter.") || found.code === "name.not-kebab-case")
    .map(({ code, message }) => ({ code, message }));

const LAUNCH =
  "fit-review-workflow-start → toParallelAgents(score-a-agent, score-b-agent, score-c-agent)";

describe("#279 AC5: a model arbiter covers every agent of its launch by a criterion", () => {
  it("unhandled agent, agent not in the launch, two criteria for one agent", () => {
    expect(arbiterErrorsOf(PartialScoreArbiter)).toEqual([
      {
        code: "arbiter.duplicate-target",
        message:
          "partial-score-arbiter has 2 criteria for ScoreBAgent — one criterion per target class",
      },
      {
        code: "arbiter.unhandled-target",
        message: `partial-score-arbiter has no criterion for ScoreCAgent for this launch (${LAUNCH}) — add one — its prompt never stands in; a target that needs no real check gets "Any non-empty answer"`,
      },
      {
        code: "arbiter.unknown-target",
        message: `partial-score-arbiter has a criterion for LegalAgent, but ${LAUNCH} does not launch LegalAgent — remove it`,
      },
    ]);
  });

  it("a criterion covers every item of a per-item launch", () => {
    const flow = [
      shortlisted(searched().arbitratedBy(ConvincingReasonArbiter).joinQuorum({ min: 5 })),
    ];
    expect(codesOf(flow)).toEqual([]);
  });

  it("a criterion covers every copy of a repeated agent", () => {
    const flow = [
      dealLaunch()
        .arbitratedBy(DueDiligenceArbiter)
        .joinQuorumGroups(
          group(LegalAgent, DealCriticAgent)
            .toAgent(FullReviewAgent)
            .toFinish(DueDiligenceReportWorkflowFinish),
          fastGroup(),
        ),
    ];
    expect(codesOf(flow)).toEqual(["arbiter.unknown-target"]); // the arbiter also judges auditor-agent
  });

  it("the arbiter must be decorated, and named in kebab-case", () => {
    expect(arbiterErrorsOf(UndecoratedArbiter)).toEqual([
      {
        code: "arbiter.not-an-arbiter",
        message:
          ".arbitratedBy(UndecoratedArbiter): UndecoratedArbiter has no @Arbiter decorator — decorate it with @Arbiter({ … })",
      },
    ]);
    expect(arbiterErrorsOf(BadlyNamedArbiter)).toEqual([
      {
        code: "name.not-kebab-case",
        message: '"Badly_Named" on @Arbiter — a name is kebab-case: "badly-named"',
      },
    ]);
  });

  it("a good arbiter adds nothing", () => {
    expect(arbiterErrorsOf(ValidScoreArbiter)).toEqual([]);
  });
});

describe("#279 AC6: a code arbiter has one @Arbitrate(Agent) method per agent", () => {
  it("unhandled target, two methods for one class", () => {
    expect(arbiterErrorsOf(TwoMethodsArbiter)).toHaveLength(2);
    expect(arbiterErrorsOf(TwoMethodsArbiter)).toEqual(
      expect.arrayContaining([
        {
          code: "arbiter.unhandled-target",
          message: `two-methods-arbiter has no @Arbitrate(ScoreCAgent) method for this launch (${LAUNCH}) — add the method`,
        },
        {
          code: "arbiter.duplicate-target",
          message:
            "two-methods-arbiter has 2 @Arbitrate(ScoreAAgent) methods (fromScoreA, checkScoreA) — one method per target class; share a rule through a private method",
        },
      ]),
    );
  });

  it("a variadic @Arbitrate(A, B, C) method covers every target it names", () => {
    expect(arbiterErrorsOf(OneMethodArbiter)).toEqual([]);
  });
});

describe("#1282: an arbiter of an .inParallel([…]) or .forEachItem(…) launch", () => {
  const parallel = (branches: readonly ReturnType<typeof toAgent>[]) => [
    onStart(FitReviewWorkflowStart)
      .inParallel(branches)
      .arbitratedBy(ValidScoreArbiter)
      .joinQuorum({ min: 2 })
      .toAgent(FitSummaryAgent)
      .toFinish(FitSummaryWorkflowFinish),
  ];

  it("judges the branches of .inParallel([…]) as it does those of .toParallelAgents(…)", () => {
    const flow = parallel([toAgent(ScoreAAgent), toAgent(ScoreBAgent), toAgent(ScoreCAgent)]);

    expect(errorsOf(flow).filter(({ code }) => code.startsWith("arbiter."))).toEqual([]);
  });

  it("a target of the launch the arbiter has no criterion for is unhandled; one it names and the launch lacks is unknown", () => {
    const flow = parallel([toAgent(ScoreAAgent), toAgent(ScoreBAgent)]);

    expect(
      errorsOf(flow)
        .filter(({ code }) => code.startsWith("arbiter."))
        .map(({ code }) => code),
    ).toEqual(["arbiter.unknown-target"]);
  });

  it("a void @Action branch gives the arbiter nothing to judge", () => {
    const flow = parallel([toAgent(ScoreAAgent), toAction(OpenDealRoomAction)]);

    expect(errorsOf(flow).filter(({ code }) => code === "arbiter.branch-has-no-output")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("an @Action without an output") as unknown,
      }),
    ]);
  });
});
