import { describe, expectTypeOf, it } from "vitest";
import { anyOf, group, onStart, toFinish } from "../../src/flow/builder.js";
import { ExecutionContext } from "../../src/flow/context/execution-context.js";
import {
  Arbiter,
  ArbiterModel,
  Arbitrate,
  type ArbitratedAnswerOf,
} from "../../src/flow/decorators/arbiter.js";
import * as index from "../../src/index.js";
import { Metadata, type Tracked } from "../../src/flow/metadata.js";
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
import { CandidateDto, DealCritiqueDto, ScoreDto, SkillsScoreDto } from "./fixtures/quorum-dtos.js";
import { GoodScoreArbiter, ValidScoreArbiter } from "./fixtures/quorum.fixture.js";

/** #279 — quorums at compile time: what may follow a launch, arbiters, groups. */

const scores = () =>
  onStart(CandidateReviewWorkflowStart).toParallelAgents(ScoreAAgent, ScoreBAgent, ScoreCAgent);
const fit = () =>
  onStart(FitReviewWorkflowStart).toParallelAgents(
    SkillsScoreAgent,
    CultureScoreAgent,
    SalaryFitAgent,
  );
const deal = () =>
  onStart(DealWorkflowStart).toParallelAgents(
    LegalAgent,
    DealCriticAgent,
    DealCriticAgent,
    AuditorAgent,
    FastScreenAgent,
    {
      maxConcurrency: 4,
    },
  );
const fastGroup = () => group(FastScreenAgent).priority(3).toFinish(QuickRejectWorkflowFinish);

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

  it("AC4: .onError right after the quorum, .onJoinError does not compile", () => {
    const joined = scores().joinQuorum({ min: 2 });
    joined
      .onError(StepFailedError, toFinish(ScoreReviewFailedWorkflowFinish))
      .toAgent(ScoreSummaryAgent);
    // @ts-expect-error — the join's handler is `.onError`: `.onJoinError` is gone (#1281)
    joined.onJoinError(StepFailedError, toFinish(ScoreReviewFailedWorkflowFinish));
    expectTypeOf(joined).toHaveProperty("onError");
  });
});

describe("#279 AC14: what follows .joinQuorum(…)", () => {
  it("min below the agents: every single answer is optional", () => {
    const joined = fit().joinQuorum({ min: 2 });
    joined.toAgent(FitSummaryAgent);
    expectTypeOf(joined).toHaveProperty("toAgent");
  });

  it("min equal to the agents: required answers are allowed", () => {
    const joined = fit().joinQuorum({ min: 3 });
    joined.toAgent(FitSummaryAgent);
    expectTypeOf(joined).toHaveProperty("toAgent");
  });

  it("one output class of several agents stays a list", () => {
    scores().joinQuorum({ min: 2 }).toAgent(ScoreSummaryAgent);
    expectTypeOf(scores()).toHaveProperty("joinQuorum");
  });
});

describe("#279 AC7 / AC13: groups continue their own path", () => {
  it("groups continue their own path", () => {
    deal().joinQuorumGroups(
      group(LegalAgent, DealCriticAgent).priority(1).toAgent(FullReviewAgent),
      group(AuditorAgent).toAction(OpenDealRoomAction).toFinish(DealRoomOpenedWorkflowFinish),
      fastGroup(),
      { deadline: seconds(60) },
    );
    expectTypeOf(deal()).toHaveProperty("joinQuorumGroups");
  });

  it("a group without a continuation does not compile; nothing follows the groups", () => {
    // @ts-expect-error — a group continues its own path with .to…(…)
    deal().joinQuorumGroups(group(FastScreenAgent));
    // @ts-expect-error — min / max do not apply to groups
    deal().joinQuorumGroups(fastGroup(), { min: 1 });
    const joined = deal().joinQuorumGroups(fastGroup());
    // @ts-expect-error — no common continuation after .joinQuorumGroups(…)
    joined.toAgent(FullReviewAgent);
    joined.onError(StepFailedError, toFinish(QuickRejectWorkflowFinish));
    expectTypeOf(joined).toHaveProperty("onError");
  });
});

describe("#279 AC6: @Arbitrate(…targets) checks the method; the options say how it decides", () => {
  it("the answer's type, the return type and one parameter", () => {
    @Arbiter({ name: "typed-score-arbiter", deps: [ExecutionContext] })
    class TypedScoreArbiter {
      constructor(readonly executionContext: ExecutionContext) {}

      @Arbitrate(ScoreAAgent)
      fromScoreA(answer: ScoreDto): boolean {
        return answer.score > this.executionContext.step.visitNumber;
      }

      @Arbitrate(ScoreBAgent)
      async fromScoreB(answer: ScoreDto): Promise<boolean> {
        return Promise.resolve(answer.score > 0);
      }

      // @ts-expect-error — score-c-agent answers ScoreDto, not CandidateDto
      @Arbitrate(ScoreCAgent)
      fromScoreC(answer: CandidateDto): boolean {
        return answer.name !== "";
      }

      // @ts-expect-error — an arbiter answers whether the answer counts: a boolean
      @Arbitrate(ScoreAAgent)
      scoreText(answer: ScoreDto): string {
        return String(answer.score);
      }

      // @ts-expect-error — one parameter, the answer
      @Arbitrate(ScoreBAgent)
      fromTwo(answer: ScoreDto, extra: string): boolean {
        return answer.score > extra.length;
      }
    }
    expectTypeOf(TypedScoreArbiter).toBeConstructibleWith({} as ExecutionContext);
  });

  it("the other strategy's options do not compile", () => {
    const criteria = [{ target: ScoreAAgent, prompt: "p" }] as const;
    const model = { name: "y-arbiter", model: "m", prompt: "p" } as const;
    const deps = [ExecutionContext] as const;
    // @ts-expect-error — a code arbiter has no criteria: its methods judge
    Arbiter({ name: "x-arbiter", criteria, deps: [] }).bind(null);
    // @ts-expect-error — a model arbiter needs its criteria
    Arbiter(model);
    // @ts-expect-error — a model arbiter has no deps
    Arbiter({ ...model, criteria, deps });
    // @ts-expect-error — `decidedBy` is gone: criteria or @Arbitrate methods decide how it decides
    Arbiter({ name: "z-arbiter", decidedBy: "code" });
    expectTypeOf(Arbiter).toBeFunction();
  });

  it("@Arbitrate(A, B) takes the union of their answers; the removed @OnAnswer is gone (#1283)", () => {
    @Arbiter({ name: "union-arbiter" })
    class UnionArbiter {
      @Arbitrate(ScoreAAgent, ScoreBAgent)
      isMeaningful(answer: ArbitratedAnswerOf<[typeof ScoreAAgent, typeof ScoreBAgent]>): boolean {
        expectTypeOf(Metadata.createdBy(answer)).toEqualTypeOf<
          typeof ScoreAAgent | typeof ScoreBAgent
        >();
        return answer.score > 0;
      }

      @Arbitrate(ScoreCAgent)
      isPlain(answer: ScoreDto): boolean {
        return answer.score > 0;
      }
    }
    expectTypeOf<ArbitratedAnswerOf<[typeof ScoreAAgent, typeof ScoreBAgent]>>().toEqualTypeOf<
      Tracked<ScoreDto, typeof ScoreAAgent> | Tracked<ScoreDto, typeof ScoreBAgent>
    >();
    expectTypeOf(UnionArbiter).toBeConstructibleWith();
    // @ts-expect-error — @OnAnswer is @Arbitrate(…targets)
    const removed: unknown = index.OnAnswer;
    expectTypeOf(removed).toBeUnknown();
  });

  it("model / modelProvider need ArbiterModel in deps; with it they compile (#1283)", () => {
    // @ts-expect-error — no ArbiterModel injected: a code arbiter has no model
    Arbiter({ name: "no-model-arbiter", model: "fast" });
    Arbiter({ name: "hybrid-arbiter", model: "fast", deps: [ArbiterModel] });
    Arbiter();
    Arbiter({ deps: [ExecutionContext] });
    expectTypeOf<ArbiterModel>().toHaveProperty("decide");
  });
});
