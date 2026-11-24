import { describe, expectTypeOf, it } from "vitest";
import * as builder from "../../../src/flow/builder.js";
import { onAction, onAgent, onRouter, onWorkflow } from "../../../src/flow/builder.js";
import { ChildPlacement } from "../../../src/flow/child-placement.js";
import { StepKind } from "../../../src/flow/ast.js";
import * as root from "../../../src/index.js";
import * as wrappers from "../../../src/flow/dto-wrappers.js";
import { listOf, oneOf, type InputOf } from "../../../src/index.js";
import { ChangesRequestedDto, DraftApprovedDto } from "../fixtures/dtos.js";
import { MainRouter } from "../fixtures/chat.fixture.js";
import { ReviewerAgent } from "../fixtures/offer.fixture.js";
import { ChargePaymentAction, PlannerAgent } from "../fixtures/launch.fixture.js";
import { CompanyReviewWorkflow } from "../fixtures/children.fixture.js";
// @ts-expect-error — Produced is gone: an input field is the DTO itself, Tracked<T, P>
import type { Produced } from "../../../src/flow/dto-wrappers.js";
// @ts-expect-error — ProducedValue is gone: there is no { producer, value } record
import type { ProducedValue } from "../../../src/flow/dto-wrappers.js";
// @ts-expect-error — Variant is gone: an action returns a plain object, told apart by its strict schema
import type { Variant } from "../../../src/flow/dto-wrappers.js";
// @ts-expect-error — PartialVariant is gone: match a class with expect.any(XDto)
import type { PartialVariant } from "../../../src/flow/dto-wrappers.js";
// @ts-expect-error — VariantOf is gone: a listOf(A, B) judge reads items that are instances of their classes
import type { VariantOf } from "../../../src/flow/dto-wrappers.js";
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

  it("Produced, ProducedValue, variant, isVariant, Variant, VariantOf are gone", () => {
    expectTypeOf<Produced<unknown, unknown>>().toBeAny();
    expectTypeOf<ProducedValue<unknown, unknown>>().toBeAny();
    expectTypeOf<Variant<never>>().toBeAny();
    expectTypeOf<PartialVariant<never>>().toBeAny();
    expectTypeOf<VariantOf<unknown>>().toBeAny();
    // @ts-expect-error — variant(XDto, value) is gone: return the plain object
    expectTypeOf(root.variant).toBeAny();
    // @ts-expect-error — isVariant(item, XDto) is gone: item instanceof XDto
    expectTypeOf(root.isVariant).toBeAny();
    // @ts-expect-error — variant is gone from the wrappers too
    expectTypeOf(wrappers.variant).toBeAny();
    // @ts-expect-error — isVariant is gone from the wrappers too
    expectTypeOf(wrappers.isVariant).toBeAny();
    // @ts-expect-error — withVariant is gone with the Produced record
    expectTypeOf(wrappers.withVariant).toBeAny();
  });

  it("the list of a oneOf is gone: listOf(A, B)", () => {
    const either = oneOf(ChangesRequestedDto, DraftApprovedDto);
    // @ts-expect-error — listOf takes DTO classes, not a oneOf(…)
    listOf(either);
    expectTypeOf(listOf(ChangesRequestedDto, DraftApprovedDto).variants).not.toBeAny();
  });

  it("an input field is the DTO itself: no .value, no .producer", () => {
    const draft = {} as InputOf<ReviewerAgent>["draft"];
    // @ts-expect-error — .value is gone: the field is the DTO
    expectTypeOf(draft.value).toBeAny();
    // @ts-expect-error — .producer is gone: Metadata.createdBy(field)
    expectTypeOf(draft.producer).toBeAny();
    expectTypeOf(draft.text).toBeString();
  });
});
