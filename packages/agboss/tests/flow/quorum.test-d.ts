import { describe, expectTypeOf, it } from "vitest";
import { anyOf, group, start, toFinish } from "../../src/flow/builder.js";
import { ExecutionContext } from "../../src/flow/context/execution-context.js";
import { Arbiter, OnAnswer } from "../../src/flow/decorators/arbiter.js";
import { DecidedBy } from "../../src/flow/decorators/router.js";
import { listOf, optional } from "../../src/flow/dto-wrappers.js";
import { StepFailedError } from "../../src/graph/errors.js";
import { seconds } from "../../src/units/index.js";
import {
  AuditorAgent,
  CultureScoreAgent,
  DealCriticAgent,
  DealWorkflowStart,
  FastScreenAgent,
  FitReviewWorkflowStart,
  FitSummaryAgent,
  FullReviewAgent,
  LegalAgent,
  OpenDealRoomAction,
  QuickRejectWorkflowFinish,
  SalaryFitAgent,
  ScoreAAgent,
  ScoreBAgent,
  ScoreCAgent,
  ScoreReviewFailedWorkflowFinish,
  ScoreSummaryAgent,
  SkillsScoreAgent,
  CandidateReviewWorkflowStart,
  DealRoomOpenedWorkflowFinish,
} from "./fixtures/quorum-agents.js";
import {
  AuditDto,
  CandidateDto,
  CultureScoreDto,
  DealCritiqueDto,
  DealDto,
  FastScreenDto,
  LegalReviewDto,
  SalaryFitDto,
  ScoreDto,
  SkillsScoreDto,
} from "./fixtures/quorum-dtos.js";
import { GoodScoreArbiter, ValidScoreArbiter } from "./fixtures/quorum.fixture.js";

/** #279 — quorums at compile time: what may follow a launch, what `.returns` may promise, arbiters. */

const scores = () =>
  start(CandidateReviewWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(ScoreAAgent, ScoreBAgent, ScoreCAgent);
const fit = () =>
  start(FitReviewWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(SkillsScoreAgent, CultureScoreAgent, SalaryFitAgent);
const deal = () =>
  start(DealWorkflowStart)
    .returns(DealDto)
    .toParallelAgents(LegalAgent, DealCriticAgent, DealCriticAgent, AuditorAgent, FastScreenAgent, {
      maxConcurrency: 4,
    });
const fastGroup = () =>
  group(FastScreenAgent).priority(3).returns(FastScreenDto).toFinish(QuickRejectWorkflowFinish);

describe("#279 AC11 / AC12: arbiters and quorum joins after a launch", () => {
  it("options are always an object; .acceptedBy(…).join() does not compile", () => {
    // @ts-expect-error — the number shorthand is gone: .joinQuorum({ min: 2 })
    scores().joinQuorum(2);
    // @ts-expect-error — after .acceptedBy(…) a quorum join, never .join()
    scores().acceptedBy(ValidScoreArbiter).join();
    // @ts-expect-error — a deadline has a unit: seconds(30), not 30
    scores().joinQuorum({ min: 2, deadline: 30 });
    scores()
      .acceptedBy(GoodScoreArbiter)
      .acceptedBy(anyOf(GoodScoreArbiter, ValidScoreArbiter))
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) });
    expectTypeOf(scores().acceptedBy(ValidScoreArbiter)).toHaveProperty("joinQuorumGroups");
  });

  it("AC4: .onJoinError right after the quorum, .onError does not compile", () => {
    const joined = scores().joinQuorum({ min: 2 });
    joined
      .onJoinError(StepFailedError, toFinish(ScoreReviewFailedWorkflowFinish))
      .returns(listOf(ScoreDto))
      .toAgent(ScoreSummaryAgent);
    // @ts-expect-error — .onError does not follow a join: .onJoinError(E, …)
    joined.onError(StepFailedError, toFinish(ScoreReviewFailedWorkflowFinish));
    expectTypeOf(joined).toHaveProperty("onJoinError");
  });
});

describe("#279 AC14: what .joinQuorum(…).returns(…) may promise", () => {
  it("min below the agents: every single answer is optional", () => {
    const joined = fit().joinQuorum({ min: 2 });
    joined
      .returns(optional(SkillsScoreDto))
      .returns(optional(CultureScoreDto))
      .returns(optional(SalaryFitDto))
      .toAgent(FitSummaryAgent);
    // @ts-expect-error — the quorum may leave skills-score-agent out: optional(SkillsScoreDto)
    joined.returns(SkillsScoreDto);
    expectTypeOf(joined).toHaveProperty("returns");
  });

  it("min equal to the agents: required answers are allowed", () => {
    const joined = fit().joinQuorum({ min: 3 });
    joined.returns(SkillsScoreDto).returns(CultureScoreDto).returns(SalaryFitDto);
    // @ts-expect-error — every answer is counted: not optional(…)
    joined.returns(optional(SkillsScoreDto));
    expectTypeOf(joined).toHaveProperty("returns");
  });

  it("one output class of several agents stays a list", () => {
    scores().joinQuorum({ min: 2 }).returns(listOf(ScoreDto)).toAgent(ScoreSummaryAgent);
    // @ts-expect-error — three agents with one output give a list
    scores().joinQuorum({ min: 2 }).returns(optional(ScoreDto));
    expectTypeOf(scores()).toHaveProperty("joinQuorum");
  });
});

describe("#279 AC7 / AC13: groups name their values and continue their own path", () => {
  it("a repeated class is listOf in every group; listed agents are required", () => {
    deal().joinQuorumGroups(
      group(LegalAgent, DealCriticAgent)
        .priority(1)
        .returns(LegalReviewDto)
        .returns(listOf(DealCritiqueDto))
        .toAgent(FullReviewAgent),
      group(AuditorAgent)
        .returns(AuditDto)
        .toAction(OpenDealRoomAction)
        .toFinish(DealRoomOpenedWorkflowFinish),
      fastGroup(),
      { deadline: seconds(60) },
    );
    deal().joinQuorumGroups(
      // @ts-expect-error — deal-critic-agent is launched twice: listOf(DealCritiqueDto), even for one copy
      group(LegalAgent, DealCriticAgent)
        .returns(LegalReviewDto)
        .returns(DealCritiqueDto)
        .toAgent(FullReviewAgent),
      fastGroup(),
    );
    deal().joinQuorumGroups(
      // @ts-expect-error — a listed agent is present when its group wins: not optional(…)
      group(AuditorAgent)
        .returns(optional(AuditDto))
        .toAction(OpenDealRoomAction)
        .toFinish(DealRoomOpenedWorkflowFinish),
    );
    expectTypeOf(deal()).toHaveProperty("joinQuorumGroups");
  });

  it("a group without a continuation does not compile; nothing follows the groups", () => {
    // @ts-expect-error — a group continues its own path with .to…(…)
    deal().joinQuorumGroups(group(FastScreenAgent).returns(FastScreenDto));
    // @ts-expect-error — min / max do not apply to groups
    deal().joinQuorumGroups(fastGroup(), { min: 1 });
    const joined = deal().joinQuorumGroups(fastGroup());
    // @ts-expect-error — no common continuation after .joinQuorumGroups(…)
    joined.toAgent(FullReviewAgent);
    joined.onJoinError(StepFailedError, toFinish(QuickRejectWorkflowFinish));
    expectTypeOf(joined).toHaveProperty("onJoinError");
  });
});

describe("#279 AC6: @OnAnswer(Agent) checks the method; options by decidedBy", () => {
  it("the answer's type, the return type and one parameter", () => {
    @Arbiter({ name: "typed-score-arbiter", decidedBy: DecidedBy.Code, deps: [ExecutionContext] })
    class TypedScoreArbiter {
      constructor(readonly executionContext: ExecutionContext) {}

      @OnAnswer(ScoreAAgent)
      fromScoreA(answer: ScoreDto): boolean {
        return answer.score > this.executionContext.step.visitNumber;
      }

      @OnAnswer(ScoreBAgent)
      async fromScoreB(answer: ScoreDto): Promise<boolean> {
        return Promise.resolve(answer.score > 0);
      }

      // @ts-expect-error — score-c-agent answers ScoreDto, not CandidateDto
      @OnAnswer(ScoreCAgent)
      fromScoreC(answer: CandidateDto): boolean {
        return answer.name !== "";
      }

      // @ts-expect-error — an arbiter answers whether the answer counts: a boolean
      @OnAnswer(ScoreAAgent)
      scoreText(answer: ScoreDto): string {
        return String(answer.score);
      }

      // @ts-expect-error — one parameter, the answer
      @OnAnswer(ScoreBAgent)
      fromTwo(answer: ScoreDto, extra: string): boolean {
        return answer.score > extra.length;
      }
    }
    expectTypeOf(TypedScoreArbiter).toBeConstructibleWith({} as ExecutionContext);
  });

  it("the other strategy's options do not compile", () => {
    const criteria = [{ agent: ScoreAAgent, prompt: "p" }] as const;
    const code = { name: "x-arbiter", decidedBy: DecidedBy.Code, criteria } as const;
    const model = {
      name: "y-arbiter",
      decidedBy: DecidedBy.Model,
      model: "m",
      prompt: "p",
    } as const;
    const deps = [ExecutionContext] as const;
    // @ts-expect-error — a code arbiter has no criteria: its methods judge
    Arbiter(code);
    // @ts-expect-error — a model arbiter needs its criteria
    Arbiter(model);
    // @ts-expect-error — a model arbiter has no deps
    Arbiter({ ...model, criteria, deps });
    expectTypeOf(Arbiter).toBeFunction();
  });
});
