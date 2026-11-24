import { describe, expectTypeOf, it } from "vitest";
import type { ChosenRouterRoute, CodeRouterRoute } from "../../../src/flow/decorators/router.js";
import type { TargetRef, UnwrapTarget } from "../../../src/flow/target-ref.js";
import {
  LazyDeskRouter,
  LazyIntakeAgent,
  LazyNoOrderFinish,
  type LazyDeskRoute,
} from "../fixtures/lazy-router.fixture.js";

/** #1271b: a router route's target is a class or a thunk of one; `Route<R>` is the classes. */
describe("#1271b: lazy router targets", () => {
  it("a route takes a class and a thunk of a class", () => {
    expectTypeOf<ChosenRouterRoute["target"]>().toEqualTypeOf<TargetRef>();
    expectTypeOf<CodeRouterRoute["target"]>().toEqualTypeOf<TargetRef>();
    expectTypeOf(LazyIntakeAgent).toExtend<ChosenRouterRoute["target"]>();
    expectTypeOf(() => LazyIntakeAgent).toExtend<ChosenRouterRoute["target"]>();
  });

  it("a thunk of anything but a class is no target", () => {
    expectTypeOf<() => number>().not.toExtend<ChosenRouterRoute["target"]>();
    expectTypeOf<string>().not.toExtend<ChosenRouterRoute["target"]>();
  });

  it("UnwrapTarget gives the class of a class and of its thunk", () => {
    expectTypeOf<UnwrapTarget<typeof LazyIntakeAgent>>().toEqualTypeOf<typeof LazyIntakeAgent>();
    expectTypeOf<UnwrapTarget<() => typeof LazyIntakeAgent>>().toEqualTypeOf<
      typeof LazyIntakeAgent
    >();
  });

  it("Route<R> of a router with thunks lists the classes", () => {
    expectTypeOf<LazyDeskRoute>().toEqualTypeOf<
      typeof LazyIntakeAgent | typeof LazyNoOrderFinish
    >();
    expectTypeOf<InstanceType<typeof LazyDeskRouter>>().toBeObject();
  });
});
