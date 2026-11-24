import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { declarationOf, type RouterDeclaration } from "../../../src/flow/decorators/declaration.js";
import { DecidedBy, Router, routesOf } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { resolveTarget } from "../../../src/flow/target-ref.js";
import { routeTargetsOf } from "../../../src/flow/types/tables.js";
import { WorkflowStartTextDto } from "../fixtures/dtos.js";
import {
  LazyDeskRouter,
  LazyIntakeAgent,
  LazyNoOrderFinish,
  LazyOrderFinish,
  LazyWorkflow,
  LazyWorkflowStart,
} from "../fixtures/lazy-router.fixture.js";
import { onStart, toAgent, toFinish } from "../fixtures/paths.js";
import { Ttl } from "../../../src/index.js";

/**
 * #1271b: `@Router({ routes })` takes `Class | (() => Class)` — the thunk for a target declared below
 * the router, which a decorator's argument cannot name (the temporal dead zone).
 */

const routerOptionsOf = (cls: object): RouterDeclaration["options"] => {
  const declaration = declarationOf(cls);
  if (declaration === undefined || !("routes" in declaration.options))
    throw new TypeError("not a router");
  return declaration.options;
};

describe("#1271b: the temporal dead zone", () => {
  it("an eager target declared below the router is a ReferenceError; the thunk is not", () => {
    const eager = (): void => {
      @Router({
        name: "eager-router",
        description: "Names a class below it",
        decidedBy: DecidedBy.Model,
        input: { message: WorkflowStartTextDto },
        // @ts-expect-error — the compiler sees the temporal dead zone too
        routes: [{ target: Below, prompt: "go" }],
      })
      class EagerRouter {
        readonly kind = "eager";
      }
      class Below {
        readonly kind = "below";
      }
      expect(EagerRouter).toBeDefined();
    };
    const lazy = (): object => {
      @Router({
        name: "lazy-router",
        description: "Names a class below it by a thunk",
        decidedBy: DecidedBy.Model,
        input: { message: WorkflowStartTextDto },
        routes: [{ target: () => Below, prompt: "go" }],
      })
      class LazyRouter {
        readonly kind = "lazy";
      }
      class Below {
        readonly kind = "below";
      }
      return LazyRouter;
    };

    expect(eager).toThrow(ReferenceError);
    expect(() => routesOf(routerOptionsOf(lazy()))).not.toThrow();
  });
});

describe("#1271b: a router with thunk targets is one router", () => {
  it("routesOf gives the classes the thunks stand for, in order, keeping the route's own fields", () => {
    const routes = routesOf(routerOptionsOf(LazyDeskRouter));

    expect(routes.map((found) => found.target)).toEqual([LazyIntakeAgent, LazyNoOrderFinish]);
    expect(routes.map((found) => found.prompt)).toEqual([
      "The customer wants to place an order",
      "Stop and hand the message over: not an order",
    ]);
  });

  it("Route<R> lists the classes: the generated table never sees an arrow function", () => {
    expect(routeTargetsOf(routerOptionsOf(LazyDeskRouter))).toEqual([
      LazyIntakeAgent,
      LazyNoOrderFinish,
    ]);
  });

  it("assembly sees no problem: the flow's routes and @Router({ routes }) are the same set", () => {
    expect(checkWorkflow(LazyWorkflow).errors).toEqual([]);
  });

  it("a thunk's route set is still checked against the flow: [router.routes-mismatch]", () => {
    @Workflow({
      name: "lazy-mismatch-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [
        onStart(LazyWorkflowStart)
          .toRouter(LazyDeskRouter)
          .onRoute(toAgent(LazyIntakeAgent).toFinish(LazyOrderFinish))
          .onRoute(toFinish(LazyOrderFinish)),
      ],
    })
    class LazyMismatchWorkflow {
      readonly kind = "mismatch";
    }

    expect(checkWorkflow(LazyMismatchWorkflow).errors.map((found) => found.code)).toContain(
      "router.routes-mismatch",
    );
  });
});

describe("#1271b: resolveTarget", () => {
  it("gives a class as it is and calls a thunk — a class is never called as a function", () => {
    class Target {
      readonly kind = "target";
    }
    let constructed = 0;
    class Counted {
      readonly built = (constructed += 1);
    }

    expect(resolveTarget(Target)).toBe(Target);
    expect(resolveTarget(() => Target)).toBe(Target);
    expect(resolveTarget(Counted)).toBe(Counted);
    expect(constructed).toBe(0);
  });
});
