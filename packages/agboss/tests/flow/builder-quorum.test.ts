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
import {
  CandidateReviewWorkflow,
  DueDiligenceWorkflow,
  GoodScoreArbiter,
  QuickScoreArbiter,
  ValidScoreArbiter,
} from "./fixtures/quorum.fixture.js";
import { onStart, toAction, toAgent, toFinish } from "./fixtures/paths.js";

/** #279 PR 1 — quorums in the path builder, the printout, `describe` and assembly. */

const flowOf = (workflow: abstract new () => unknown): readonly FlowPath[] => {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new Error("not a workflow");
  return declaration.options.flow;
};

const launched = () => onStart(FitReviewWorkflowStart).toParallelAgents(ScoreAAgent, ScoreBAgent);

const lastJoin = (steps: FlowPath["steps"]): JoinStep | undefined =>
  steps.flatMap((step) => (step.kind === StepKind.Join ? [step] : [])).pop();

describe("#279: the AST of quorums", () => {
  it("arbitratedBy sits on the launch, one arbiter, whichever launch it is", () => {
    const path = launched()
      .arbitratedBy(GoodScoreArbiter)
      .joinQuorum({ min: 1, max: 2, deadline: seconds(30) });
    const launch = path.steps.find((step) => step.kind === StepKind.Launch);
    expect(launch?.kind === StepKind.Launch ? launch.arbitratedBy : undefined).toBe(
      GoodScoreArbiter,
    );
    const parallel = onStart(FitReviewWorkflowStart)
      .inParallel([toAgent(ScoreAAgent), toAgent(ScoreBAgent)])
      .arbitratedBy(ValidScoreArbiter)
      .joinQuorum({ min: 1 });
    const each = onStart(FitReviewWorkflowStart)
      .forEachItem(toAgent(ScoreAAgent), { takeFirst: 3 })
      .arbitratedBy(QuickScoreArbiter)
      .joinQuorum({ min: 1 });
    expect(parallel.steps.find((step) => step.kind === StepKind.InParallel)).toMatchObject({
      arbitratedBy: ValidScoreArbiter,
    });
    expect(each.steps.find((step) => step.kind === StepKind.ForEachItem)).toMatchObject({
      arbitratedBy: QuickScoreArbiter,
    });
    expect(lastJoin(path.steps)?.quorum).toEqual({
      kind: QuorumKind.Count,
      min: 1,
      max: 2,
      deadline: 30_000,
    });
  });

  it("groups keep their targets, priority and own path", () => {
    const join = lastJoin(flowOf(DueDiligenceWorkflow)[0]?.steps ?? []);
    const groups = join?.quorum?.kind === QuorumKind.Groups ? join.quorum.groups : [];
    expect(groups.map((found) => [found.targets.length, found.priority])).toEqual([
      [2, 1],
      [1, 1],
      [2, 2],
      [1, 3],
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
      "arbitratedBy then .join()",
      () => launched().arbitratedBy(GoodScoreArbiter).join(),
      "not .join()",
    ],
    [
      "arbitratedBy without a launch",
      () => onStart(FitReviewWorkflowStart).arbitratedBy(GoodScoreArbiter),
      "right after",
    ],
    [
      "arbitratedBy after actions",
      () =>
        onStart(FitReviewWorkflowStart)
          .toParallelActions(OpenDealRoomAction)
          .arbitratedBy(GoodScoreArbiter),
      "judges answers",
    ],
    [
      "arbitratedBy twice: one arbiter decides a launch",
      () => launched().arbitratedBy(GoodScoreArbiter).arbitratedBy(ValidScoreArbiter),
      "once per launch",
    ],
    [
      "a quorum of groups after forEachItem",
      () =>
        onStart(FitReviewWorkflowStart)
          .forEachItem(toAgent(ScoreAAgent), { takeFirst: 2 })
          .joinQuorumGroups(),
      "one target per item",
    ],
    [
      "a quorum of actions",
      () =>
        onStart(FitReviewWorkflowStart)
          .toParallelActions(OpenDealRoomAction)
          .joinQuorum({ min: 1 }),
      "agents' answers",
    ],
    ["arbitratedBy of a non-class", () => launched().arbitratedBy("x"), "one @Arbiter class"],
    ["groups with min", () => launched().joinQuorumGroups({ min: 1 }), "do not apply"],
    ["a join of groups takes an object", () => launched().joinQuorumGroups(5), "an object"],
    [
      "onGroup without groups' join",
      () => launched().join().onGroup([ScoreAAgent], toFinish(NotifyReviewerAction)),
      "right after .joinQuorumGroups",
    ],
    [
      "priority 0",
      () =>
        launched()
          .joinQuorumGroups()
          .onGroup([ScoreAAgent], { priority: 0 }, toFinish(NotifyReviewerAction)),
      "positive integer",
    ],
    [
      "an empty group",
      () => launched().joinQuorumGroups().onGroup([], toFinish(NotifyReviewerAction)),
      "one or more classes",
    ],
    [
      "a group that is no path",
      () => launched().joinQuorumGroups().onGroup([ScoreAAgent], "x"),
      "side paths",
    ],
    ["onGroup with no path", () => launched().joinQuorumGroups().onGroup([ScoreAAgent]), "subPath"],
    [
      "onError after onGroup (#1284: before the first group only)",
      () =>
        launched()
          .joinQuorumGroups()
          .onGroup([ScoreAAgent], toFinish(NotifyReviewerAction))
          .onError(Error, toFinish(NotifyReviewerAction)),
      "before its first .onGroup",
    ],
    [
      "a step after the groups",
      () =>
        launched()
          .joinQuorumGroups()
          .onGroup([ScoreAAgent], toFinish(NotifyReviewerAction))
          .toAgent(CompanyVetAgent),
      "nothing follows",
    ],
  ])("%s", (_case, build, message) => {
    expect(build).toThrow(FlowSyntaxError);
    expect(build).toThrow(message);
  });
});

describe("#279 AC9: the printout and describe", () => {
  it("prints arbitratedBy and the quorum's options as written", () => {
    expect(flowLines(flowOf(CandidateReviewWorkflow))).toEqual(
      expect.arrayContaining([
        "  .arbitratedBy(ValidScoreArbiter)",
        "  .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })",
      ]),
    );
  });

  it("onGroup keeps targets as listed, an optional priority and its own path, in the order written", () => {
    const path = launched()
      .joinQuorumGroups({ deadline: hours(1) })
      .onError(Error, toFinish(NotifyReviewerAction))
      .onGroup([ScoreAAgent, ScoreAAgent], { priority: 2 }, toAction(OpenDealRoomAction))
      .onGroup([ScoreBAgent], toFinish(NotifyReviewerAction));
    const quorum = lastJoin(path.steps)?.quorum;
    expect(quorum).toMatchObject({ kind: QuorumKind.Groups, deadline: hours(1) });
    const groups = quorum?.kind === QuorumKind.Groups ? quorum.groups : [];
    expect(groups.map((found) => [found.targets, found.priority])).toEqual([
      [[ScoreAAgent, ScoreAAgent], 2],
      [[ScoreBAgent], undefined],
    ]);
    expect(groups[1]).not.toHaveProperty("priority");
    expect(lastJoin(path.steps)?.onError).toHaveLength(1);
    expect(flowLines([path])).toEqual(
      expect.arrayContaining([
        "  .joinQuorumGroups({ deadline: hours(1) })",
        "  .onGroup([ScoreAAgent, ScoreAAgent], { priority: 2 }, toAction(OpenDealRoomAction))",
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
