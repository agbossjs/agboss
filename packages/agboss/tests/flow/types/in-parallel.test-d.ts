import { describe, expectTypeOf, it } from "vitest";
import type { FlowPath } from "../../../src/flow/ast.js";
import {
  inParallel,
  onStart,
  skip,
  toAgent,
  toFinish,
  toRouter,
} from "../../../src/flow/builder.js";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import {
  ArticleWriterAgent,
  CompanyAuditAgent,
  CriticAgent,
  PlannerAgent,
  RankerAgent,
  RankingWorkflowFinish,
  ScreeningAgent,
  ScreeningWorkflowStart,
} from "../fixtures/launch.fixture.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import {
  ParallelPanelRouter,
  ParallelPanelWorkflowStart,
  ParallelPanelWriterAgent,
} from "../fixtures/in-parallel.fixture.js";
import { PlanResearcherAgent } from "../fixtures/launch.fixture.js";
import { GoodScoreArbiter } from "../fixtures/quorum.fixture.js";

/** #1279a: `.inParallel([…])` takes branches, skip() stands on a branch only, `.join()` follows. */

describe("#1279a: .inParallel([…branches], options?)", () => {
  const planned = () => onStart(ParallelPanelWorkflowStart).toAgent(PlannerAgent);

  it("is followed by .join() and nothing else", () => {
    const launched = planned().inParallel([toAgent(PlanResearcherAgent), toAgent(CriticAgent)]);
    expectTypeOf(launched).toHaveProperty("join");
    expectTypeOf(launched).not.toHaveProperty("toAgent");
    const path: FlowPath = launched
      .join()
      .toAgent(ArticleWriterAgent)
      .toAgent(ParallelPanelWriterAgent);
    expectTypeOf(path).toEqualTypeOf<FlowPath>();
  });

  it("takes options as the second argument, maxConcurrency only", () => {
    planned().inParallel([toAgent(CriticAgent)], { maxConcurrency: 2 });
    // @ts-expect-error — maxItems is forEachItem's
    planned().inParallel([toAgent(CriticAgent)], { maxItems: 2 });
  });

  it("branches are an array of one or more", () => {
    // @ts-expect-error — not an array
    planned().inParallel(toAgent(CriticAgent));
    // @ts-expect-error — at least one branch
    planned().inParallel([]);
  });

  it("a branch is an agent, an action, a question role or a child workflow", () => {
    planned().inParallel([toAgent(CriticAgent), toAgent(PlanResearcherAgent)]);
  });

  it("skip() stands right after a branch's step", () => {
    toAgent(CriticAgent).onError(StepError, skip());
    // @ts-expect-error — a flow path's step has no skip()
    planned().onError(StepError, skip());
  });

  it("the standalone starter gives a launch too", () => {
    expectTypeOf(inParallel([toAgent(CriticAgent)])).toHaveProperty("join");
  });

  it("toRouter(R).chooseMany([…]) is a branch: its branches are the router's routes (#1279b)", () => {
    planned().inParallel([
      toAgent(PlanResearcherAgent),
      toRouter(ParallelPanelRouter).chooseMany([
        toAgent(PlanResearcherAgent),
        toAgent(CriticAgent).onError(StepError, skip()),
      ]),
    ]);
    const picks = toRouter(ParallelPanelRouter);
    // @ts-expect-error — PlannerAgent is no route of the router
    picks.chooseMany([toAgent(PlannerAgent)]);
  });

  it("chooseMany stands in a branch, never in a flow path", () => {
    const router = planned().toRouter(ParallelPanelRouter);
    // @ts-expect-error — a flow path's router has routes, not chooseMany
    router.chooseMany([toAgent(CriticAgent)]);
  });

  it("forEachItem takes exactly one bound; a maxItems launch needs its LimitError.Items handler (#1280)", () => {
    const listed = onStart(ScreeningWorkflowStart).toAgent(ScreeningAgent);
    listed
      .forEachItem(toAgent(CompanyAuditAgent), { takeFirst: 3, maxConcurrency: 2 })
      .join()
      .toAgent(RankerAgent);
    // @ts-expect-error — both bounds at once is no option
    listed.forEachItem(toAgent(CompanyAuditAgent), { takeFirst: 3, maxItems: 4 });
    // @ts-expect-error — neither bound is given
    listed.forEachItem(toAgent(CompanyAuditAgent), {});
    const needing = listed.forEachItem(toAgent(CompanyAuditAgent), { maxItems: 3 }).join();
    expectTypeOf(needing).not.toHaveProperty("toAgent");
    const cleared = needing.onError(LimitError.Items, toFinish(RankingWorkflowFinish));
    expectTypeOf(cleared).toHaveProperty("toAgent");
    expectTypeOf(needing.onError(LimitError, toFinish(RankingWorkflowFinish))).toHaveProperty(
      "toAgent",
    );
    expectTypeOf(needing.onError(StepError, toFinish(RankingWorkflowFinish))).not.toHaveProperty(
      "toAgent",
    );
  });

  it("a quorum follows .inParallel([…]) and .forEachItem(…), with or without .arbitratedBy(A) (#1282)", () => {
    const parallel = planned().inParallel([toAgent(PlanResearcherAgent), toAgent(CriticAgent)]);
    expectTypeOf(parallel).toHaveProperty("join");
    expectTypeOf(parallel.joinQuorum({ min: 1 })).toHaveProperty("toAgent");
    expectTypeOf(parallel.arbitratedBy(GoodScoreArbiter)).toHaveProperty("joinQuorumGroups");
    expectTypeOf(parallel.arbitratedBy(GoodScoreArbiter).joinQuorum({ min: 1 })).toHaveProperty(
      "toAgent",
    );
    // @ts-expect-error — after .arbitratedBy(…) a quorum join, never .join()
    parallel.arbitratedBy(GoodScoreArbiter).join();
    // @ts-expect-error — one arbiter per launch
    parallel.arbitratedBy(GoodScoreArbiter).arbitratedBy(GoodScoreArbiter);

    const listed = onStart(ScreeningWorkflowStart).toAgent(ScreeningAgent);
    const taken = listed.forEachItem(toAgent(CompanyAuditAgent), { takeFirst: 3 });
    expectTypeOf(taken).toHaveProperty("join");
    expectTypeOf(taken.joinQuorum({ min: 1 })).toHaveProperty("toAgent");
    expectTypeOf(taken.arbitratedBy(GoodScoreArbiter).joinQuorum({ min: 1 })).toHaveProperty(
      "toAgent",
    );
    // @ts-expect-error — every item runs one target: there are no groups to tell apart
    const groups: unknown = taken.arbitratedBy(GoodScoreArbiter).joinQuorumGroups;
    expectTypeOf(groups).toBeUnknown();
    // @ts-expect-error — after .arbitratedBy(…) a quorum join, never .join()
    taken.arbitratedBy(GoodScoreArbiter).join();

    const strict = listed
      .forEachItem(toAgent(CompanyAuditAgent), { maxItems: 3 })
      .arbitratedBy(GoodScoreArbiter)
      .joinQuorum({ min: 1 });
    expectTypeOf(strict).not.toHaveProperty("toAgent");
    expectTypeOf(strict.onError(LimitError.Items, toFinish(RankingWorkflowFinish))).toHaveProperty(
      "toAgent",
    );
    expectTypeOf(strict.onError(StepError, toFinish(RankingWorkflowFinish))).not.toHaveProperty(
      "toAgent",
    );
  });
});
