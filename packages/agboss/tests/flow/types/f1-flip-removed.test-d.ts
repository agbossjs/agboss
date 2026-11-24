import { describe, expectTypeOf, it } from "vitest";
import * as builder from "../../../src/flow/builder.js";
import { onAction, onAgent, onRouter, onWorkflow } from "../../../src/flow/builder.js";
import { ChildPlacement } from "../../../src/flow/child-placement.js";
import { StepKind } from "../../../src/flow/ast.js";
import { MainRouter } from "../fixtures/chat.fixture.js";
import { ReviewerAgent } from "../fixtures/offer.fixture.js";
import { ChargePaymentAction, PlannerAgent } from "../fixtures/launch.fixture.js";
import { CompanyReviewWorkflow } from "../fixtures/children.fixture.js";
// @ts-expect-error — SpawnPolicy is gone: a router's route is { target, prompt } (model) or a class (code)
import type { SpawnPolicy } from "../../../src/flow/decorators/router.js";
// @ts-expect-error — FailurePolicy is gone: `.onError(E, skip())` on a branch
import type { FailurePolicy } from "../../../src/flow/decorators/router.js";
// @ts-expect-error — CodeRouterRoute is gone: a code router's route is its target class
import type { CodeRouterRoute } from "../../../src/flow/decorators/router.js";
// @ts-expect-error — AlwaysRouterRoute is gone: the siblings of `toRouter(R).chooseMany([…])` always run
import type { AlwaysRouterRoute } from "../../../src/flow/decorators/router.js";
// @ts-expect-error — RouterRoute is gone: ChosenRouterRoute is the one route of a model router
import type { RouterRoute } from "../../../src/flow/decorators/router.js";
// @ts-expect-error — LaunchStep is gone: StepKind.InParallel / StepKind.ForEachItem
import type { LaunchStep } from "../../../src/flow/ast.js";
// @ts-expect-error — SwitchStep is gone: StepKind.OneOf / StepKind.OnFinish
import type { SwitchStep } from "../../../src/flow/ast.js";
// @ts-expect-error — RouterLaunches is gone: a router in a launch is toRouter(R).chooseMany([…])
import type { RouterLaunches } from "../../../src/flow/launch-types.js";
// @ts-expect-error — IsPerItem is gone: `.forEachItem(step, …)` is the per-item launch
import type { IsPerItem } from "../../../src/flow/launch-types.js";

/** F1: the flow forms removed in the quiet-window flip stay removed. */
describe("F1: the old flow forms are gone", () => {
  it("the builder has no route(…), caseOf(…) starters", () => {
    // @ts-expect-error — route(X) is gone: .onRoute(toAgent(X)…)
    expectTypeOf(builder.route).toBeAny();
    // @ts-expect-error — caseOf(Dto) is gone: .toOneOf([…]) takes branches, no DTO
    expectTypeOf(builder.caseOf).toBeAny();
  });

  it("a router has .onRoute(…), no .chooseOne(…)", () => {
    // @ts-expect-error — .chooseOne(route(…)…) is gone: one .onRoute(…) per route
    expectTypeOf(onRouter(MainRouter).chooseOne).toBeAny();
    expectTypeOf(onRouter(MainRouter)).toHaveProperty("onRoute");
  });

  it("a oneOf output has .toOneOf([…]), no .switch(caseOf(…)…)", () => {
    // @ts-expect-error — .switch(…) is gone: .toOneOf([…])
    expectTypeOf(onAgent(ReviewerAgent).switch).toBeAny();
    expectTypeOf(onAgent(ReviewerAgent)).toHaveProperty("toOneOf");
  });

  it("a launch is .inParallel([…]) or .forEachItem(…), no .toParallel…(…)", () => {
    // @ts-expect-error — .toParallelAgents(…) is gone: .inParallel([toAgent(A), …])
    expectTypeOf(onAgent(PlannerAgent).toParallelAgents).toBeAny();
    // @ts-expect-error — .toParallelActions(…) is gone: .inParallel([toAction(X), …])
    expectTypeOf(onAction(ChargePaymentAction).toParallelActions).toBeAny();
    // @ts-expect-error — .toParallelWorkflows(W, …) is gone: .forEachItem(toWorkflow(W), …)
    expectTypeOf(onWorkflow(CompanyReviewWorkflow).toParallelWorkflows).toBeAny();
    expectTypeOf(onAgent(PlannerAgent)).toHaveProperty("inParallel");
  });

  it("the steps of the old forms are no StepKind", () => {
    // @ts-expect-error — StepKind.Launch is gone
    expectTypeOf(StepKind.Launch).toBeAny();
    // @ts-expect-error — StepKind.Switch is gone
    expectTypeOf(StepKind.Switch).toBeAny();
  });

  it("the old placement members are gone", () => {
    // @ts-expect-error — ChildPlacement.ParentInstance is gone: ChildPlacement.CurrentProcess
    expectTypeOf(ChildPlacement.ParentInstance).toBeAny();
    // @ts-expect-error — ChildPlacement.AnyInstance is gone: ChildPlacement.AnyWorker
    expectTypeOf(ChildPlacement.AnyInstance).toBeAny();
    expectTypeOf<SpawnPolicy>().toBeAny();
    expectTypeOf<FailurePolicy>().toBeAny();
    expectTypeOf<CodeRouterRoute>().toBeAny();
    expectTypeOf<AlwaysRouterRoute>().toBeAny();
    expectTypeOf<RouterRoute>().toBeAny();
    expectTypeOf<LaunchStep>().toBeAny();
    expectTypeOf<SwitchStep>().toBeAny();
    expectTypeOf<RouterLaunches>().toBeAny();
    expectTypeOf<IsPerItem>().toBeAny();
  });
});
