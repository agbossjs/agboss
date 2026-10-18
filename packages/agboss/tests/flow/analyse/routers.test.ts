import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { launchViolations } from "../../../src/flow/analyse/rules/routers.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { declarationOf, type RouterDeclaration } from "../../../src/flow/decorators/declaration.js";
import { DecidedBy, Router, SpawnPolicy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { OfferDraftDto, ShortlistDto } from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  DraftKitWorkflowFinish,
  EditKitAgent,
  KitRouter,
  KitWorkflowStart,
  SecondKitWorkflowStart,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { CreditWorkflow } from "../fixtures/credit.fixture.js";
import { route, router, start } from "../fixtures/paths.js";
import { TopicsWorkflow } from "../fixtures/topics.fixture.js";

/** Router rules (#272 AC6, #270, #280): routes as sets, input, model. */

const entry = () => start(SecondKitWorkflowStart).returns(OfferDraftDto).toRouter(KitRouter);
const editAgain = () => route(EditKitAgent).returns(OfferDraftDto).toRouter(KitRouter);

@Workflow({
  name: "reordered-routes-workflow",
  version: "1.0.0",
  flow: [entry(), router(KitRouter).chooseOne(route(DraftKitWorkflowFinish), editAgain())],
})
class ReorderedRoutesWorkflow {}

@Workflow({
  name: "mismatched-routes-workflow",
  version: "1.0.0",
  flow: [entry(), router(KitRouter).chooseOne(editAgain(), route(SentKitWorkflowFinish))],
})
class MismatchedRoutesWorkflow {}

@Workflow({
  name: "duplicate-route-workflow",
  version: "1.0.0",
  flow: [
    entry(),
    router(KitRouter).chooseOne(
      route(DraftKitWorkflowFinish),
      route(DraftKitWorkflowFinish),
      editAgain(),
    ),
  ],
})
class DuplicateRouteWorkflow {}

@Router({
  name: "blind-router",
  description: "Reads nothing, has no model",
  decidedBy: DecidedBy.Model,
  input: {},
  routes: [
    { target: DraftKitWorkflowFinish, prompt: "Stop and send the answer: always" },
    { target: DraftKitWorkflowFinish, prompt: "Stop and send the answer: again" },
  ],
})
class BlindRouter {}

const blindPaths = [
  start(SecondKitWorkflowStart)
    .returns(OfferDraftDto)
    .toRouter(BlindRouter)
    .chooseOne(route(DraftKitWorkflowFinish)),
];

@Workflow({ name: "blind-router-workflow", version: "1.0.0", flow: blindPaths })
class BlindRouterWorkflow {}

@Workflow({
  name: "default-model-workflow",
  version: "1.0.0",
  flow: blindPaths,
  defaults: { router: { model: "typesafe/jev-1.13" } },
})
class DefaultModelWorkflow {}

@Workflow({
  name: "choose-after-agent-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .chooseOne(route(DraftKitWorkflowFinish)),
  ],
})
class ChooseAfterAgentWorkflow {}

const errorsOf = (workflow: abstract new () => unknown) =>
  checkWorkflow(workflow).errors.map(({ code, message }) => ({ code, message }));

describe("AC6: routes mismatch as sets", () => {
  it("the flow's routes in another order than @Router({ routes }) pass", () => {
    expect(errorsOf(ReorderedRoutesWorkflow)).toEqual([]);
  });

  it("different targets fail, naming the missing and the extra ones", () => {
    expect(errorsOf(MismatchedRoutesWorkflow)).toContainEqual({
      code: "router.routes-mismatch",
      message:
        "mismatched-routes-workflow: kit-router: the flow's routes and @Router({ routes }) differ — not in @Router({ routes }): sent-kit-workflow-finish; missing in .chooseOne(…): draft-kit-workflow-finish",
    });
  });

  it("a target listed twice in the flow fails", () => {
    expect(errorsOf(DuplicateRouteWorkflow)).toEqual([
      {
        code: "router.duplicate-route",
        message:
          "duplicate-route-workflow: kit-router: route(…) to draft-kit-workflow-finish is listed twice in .chooseOne(…) — list each target once",
      },
    ]);
  });
});

describe("AC11: router assembly rules — input and model (#270, #280)", () => {
  it("an empty input, a target listed twice in routes and no model fail", () => {
    expect(errorsOf(BlindRouterWorkflow)).toEqual([
      {
        code: "router.duplicate-route",
        message:
          "blind-router-workflow: blind-router: @Router({ routes }) lists draft-kit-workflow-finish twice — list each target once",
      },
      {
        code: "router.empty-input",
        message:
          "blind-router-workflow: blind-router has an empty input — declare what it chooses by: input: { message: XDto }",
      },
      {
        code: "router.no-model",
        message:
          "blind-router-workflow: blind-router uses DecidedBy.Model but has no model — set model or defaults.router.model",
      },
    ]);
  });

  it("defaults.router.model gives a router its model", () => {
    expect(errorsOf(DefaultModelWorkflow).map((found) => found.code)).not.toContain(
      "router.no-model",
    );
  });

  it(".chooseOne(…) only follows a router", () => {
    expect(errorsOf(ChooseAfterAgentWorkflow)).toContainEqual({
      code: "graph.choose-from-non-router",
      message:
        "choose-after-agent-workflow: draft-kit-agent is not a router — .chooseOne(…) follows .toRouter(…) or router(…)",
    });
  });
});

@Router({
  name: "always-router",
  description: "Launches everything itself",
  decidedBy: DecidedBy.Code,
  input: { draft: OfferDraftDto },
  routes: [
    { target: DraftKitWorkflowFinish, spawn: SpawnPolicy.Always },
    { target: SentKitWorkflowFinish, spawn: SpawnPolicy.Always },
  ],
})
class AlwaysRouter {
  route(): undefined {
    return undefined;
  }
}

@Router({
  name: "blind-code-router",
  description: "Reads nothing",
  decidedBy: DecidedBy.Code,
  input: {},
  routes: [{ target: DraftKitWorkflowFinish }],
})
class BlindCodeRouter {
  route(): typeof DraftKitWorkflowFinish {
    return DraftKitWorkflowFinish;
  }
}

@Workflow({
  name: "blind-code-router-workflow",
  version: "1.0.0",
  flow: [
    start(SecondKitWorkflowStart)
      .returns(OfferDraftDto)
      .toRouter(BlindCodeRouter)
      .chooseOne(route(DraftKitWorkflowFinish)),
  ],
})
class BlindCodeRouterWorkflow {}

describe("#280: router rules for both kinds", () => {
  it("AC1: the credit flow — a code router inside a model router's route — passes", () => {
    expect(errorsOf(CreditWorkflow)).toEqual([]);
  });

  it("AC15: a code router needs a non-empty input too, and no model", () => {
    expect(errorsOf(BlindCodeRouterWorkflow)).toEqual([
      {
        code: "router.empty-input",
        message:
          "blind-code-router-workflow: blind-code-router has an empty input — declare what it chooses by: input: { message: XDto }",
      },
    ]);
  });

  it("AC3 / AC16: spawn and failure on both kinds fail with .chooseOne(…)", () => {
    expect(errorsOf(TopicsWorkflow)).toEqual([
      {
        code: "router.policy-with-choose-one",
        message:
          "topics-workflow: topics-router: spawn / failure on the routes to order-topic-agent, refund-topic-agent apply to a parallel launch (.toParallelAgents(…)) — remove them for .chooseOne(…)",
      },
    ]);
  });

  it("AC16: before a launch, all routes Always — the router decides nothing", () => {
    expect(launchViolations("always-router", routerDeclarationOf(AlwaysRouter))).toEqual([
      expect.objectContaining({ code: "router.all-routes-always" }),
    ]);
  });

  it("the defaults per kind: a model router's route is Always, a code router's OnDemand", () => {
    expect(launchViolations("kit-router", routerDeclarationOf(KitRouter))).toEqual([
      {
        code: "router.all-routes-always",
        message:
          "kit-router: every route is spawn: SpawnPolicy.Always (a model router's default), so it decides nothing — set spawn: SpawnPolicy.OnDemand on the routes it chooses, or launch them with .toParallelAgents(…) without a router",
        nodes: ["kit-router"],
      },
    ]);
    expect(launchViolations("blind-code-router", routerDeclarationOf(BlindCodeRouter))).toEqual([]);
  });

  it("with .chooseOne(…) spawn policies do not apply: no all-routes-always for a model router", () => {
    expect(errorsOf(ReorderedRoutesWorkflow).map((found) => found.code)).not.toContain(
      "router.all-routes-always",
    );
  });
});

function routerDeclarationOf(router: abstract new () => unknown): RouterDeclaration {
  const declaration = declarationOf(router);
  if (declaration?.kind !== NodeKind.Router) throw new TypeError("not a router");
  return declaration;
}
