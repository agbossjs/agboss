import { describe, expect, it } from "vitest";
import { workflowOf } from "../../src/components/assemble.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type FlowPath,
  type JoinStep,
} from "../../src/flow/ast.js";
import { anyOf } from "../../src/flow/builder.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { flowLines } from "../../src/flow/print.js";
import { FlowSyntaxError } from "../../src/flow/launch-step.js";
import { inputLines } from "../../src/describe/inputs.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import {
  CompanyVetAgent,
  DealCriticAgent,
  FitReviewWorkflowStart,
  NotifyReviewerAction,
  OpenDealRoomAction,
  ScoreAAgent,
  ScoreBAgent,
} from "./fixtures/quorum-agents.js";
import { CandidateDto, FastScreenDto } from "./fixtures/quorum-dtos.js";
import {
  CandidateReviewWorkflow,
  DueDiligenceWorkflow,
  GoodScoreArbiter,
  QuickScoreArbiter,
  ValidScoreArbiter,
} from "./fixtures/quorum.fixture.js";
import { group, start } from "./fixtures/paths.js";

/** #279 PR 1 — quorums in the path builder, the printout, `describe` and assembly. */

const flowOf = (workflow: abstract new () => unknown): readonly FlowPath[] => {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new Error("not a workflow");
  return declaration.options.flow;
};

const launched = () =>
  start(FitReviewWorkflowStart).returns(CandidateDto).toParallelAgents(ScoreAAgent, ScoreBAgent);

const lastJoin = (steps: FlowPath["steps"]): JoinStep | undefined =>
  steps.flatMap((step) => (step.kind === StepKind.Join ? [step] : [])).pop();

describe("#279: the AST of quorums", () => {
  it("acceptedBy on the launch, in path order; anyOf keeps its order", () => {
    const path = launched()
      .acceptedBy(GoodScoreArbiter)
      .acceptedBy(anyOf(QuickScoreArbiter, ValidScoreArbiter))
      .joinQuorum({ min: 1, max: 2, deadline: seconds(30) });
    const launch = path.steps.find((step) => step.kind === StepKind.Launch);
    expect(launch?.kind === StepKind.Launch ? launch.acceptedBy : undefined).toEqual([
      { arbiters: [GoodScoreArbiter] },
      { arbiters: [QuickScoreArbiter, ValidScoreArbiter] },
    ]);
    expect(lastJoin(path.steps)?.quorum).toEqual({
      kind: QuorumKind.Count,
      min: 1,
      max: 2,
      deadline: 30_000,
    });
  });

  it("groups keep their agents, priority, values and own path", () => {
    const join = lastJoin(flowOf(DueDiligenceWorkflow)[0]?.steps ?? []);
    const groups = join?.quorum?.kind === QuorumKind.Groups ? join.quorum.groups : [];
    expect(
      groups.map((found) => [found.agents.length, found.priority, found.returns.length]),
    ).toEqual([
      [2, 1, 2],
      [1, 1, 1],
      [2, 2, 1],
      [1, 3, 1],
    ]);
    expect(join?.quorum?.deadline).toBe(minutes(1));
    expect(groups[1]?.path.steps[0]).toMatchObject({
      kind: StepKind.To,
      target: OpenDealRoomAction,
    });
  });
});

describe("#279 AC11 / AC12: the untyped builder refuses the wrong forms", () => {
  it.each([
    ["the number shorthand", () => launched().joinQuorum(2), "not .joinQuorum(2)"],
    ["min not a positive integer", () => launched().joinQuorum({ min: 0 }), "positive integer"],
    ["max below min", () => launched().joinQuorum({ min: 2, max: 1 }), "at least min"],
    ["a bare deadline", () => launched().joinQuorum({ min: 1, deadline: -1 }), "positive duration"],
    [
      "acceptedBy then .join()",
      () => launched().acceptedBy(GoodScoreArbiter).join(),
      "not .join()",
    ],
    [
      "acceptedBy without a launch",
      () => start(FitReviewWorkflowStart).acceptedBy(GoodScoreArbiter),
      "right after",
    ],
    [
      "acceptedBy after actions",
      () =>
        start(FitReviewWorkflowStart)
          .toParallelActions(OpenDealRoomAction)
          .acceptedBy(GoodScoreArbiter),
      "judges agents",
    ],
    [
      "a quorum of actions",
      () =>
        start(FitReviewWorkflowStart).toParallelActions(OpenDealRoomAction).joinQuorum({ min: 1 }),
      "agents' answers",
    ],
    ["acceptedBy of a non-class", () => launched().acceptedBy("x"), "an @Arbiter class"],
    [
      "anyOf of one arbiter",
      () => {
        Reflect.apply(anyOf, undefined, [GoodScoreArbiter]);
      },
      "two or more",
    ],
    [
      "groups with min",
      () =>
        launched().joinQuorumGroups(group(ScoreAAgent).toFinish(NotifyReviewerAction), { min: 1 }),
      "do not apply",
    ],
    [
      "groups without a group",
      () => launched().joinQuorumGroups({ deadline: hours(1) }),
      "group(…) paths",
    ],
    ["priority 0", () => group(DealCriticAgent).priority(0), "positive integer"],
    [
      "priority after returns",
      () => group(DealCriticAgent).returns(FastScreenDto).priority(1),
      "right after group",
    ],
    ["an empty group", () => group(), "one or more agent classes"],
    [
      "returns after the groups",
      () =>
        launched()
          .joinQuorumGroups(group(ScoreAAgent).toFinish(NotifyReviewerAction))
          .returns(FastScreenDto),
      "each group names its values",
    ],
    [
      "a step after the groups",
      () =>
        launched()
          .joinQuorumGroups(group(ScoreAAgent).toFinish(NotifyReviewerAction))
          .toAgent(CompanyVetAgent),
      "nothing follows",
    ],
  ])("%s", (_case, build, message) => {
    expect(build).toThrow(FlowSyntaxError);
    expect(build).toThrow(message);
  });
});

describe("#279 AC9: the printout and describe", () => {
  it("prints acceptedBy, anyOf and the quorum's options as written", () => {
    expect(flowLines(flowOf(CandidateReviewWorkflow))).toEqual(
      expect.arrayContaining([
        "  .acceptedBy(anyOf(QuickScoreArbiter, ValidScoreArbiter))",
        "  .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })",
      ]),
    );
  });

  it("prints a deadline in hours", () => {
    const path = launched().joinQuorum({ min: 1, deadline: hours(2) });
    expect(flowLines([path])).toContain("  .joinQuorum({ min: 1, deadline: hours(2) })");
  });

  it("describe shows each counted list's producers with counts", () => {
    const { analysis } = checkWorkflow(DueDiligenceWorkflow);
    expect(analysis === undefined ? [] : inputLines(analysis)).toEqual(
      expect.arrayContaining([
        "full-review-agent ← deal: deal-workflow-start, legal: legal-agent (optional), critiques: deal-critic-agent ×1–2",
        "second-opinion-router ← critiques: deal-critic-agent ×2",
      ]),
    );
  });
});

describe("#279 PR 2: a workflow with a quorum assembles", () => {
  it("its model arbiters are model uses of the workflow", async () => {
    const assembled = await workflowOf(CandidateReviewWorkflow);

    expect(assembled.arbiters).toEqual([
      { name: "valid-score-arbiter", model: "typesafe/jev-1.13" },
    ]);
  });
});
