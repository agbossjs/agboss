import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { OfferDraftDto } from "../fixtures/dtos.js";
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
import { inline } from "../../../src/index.js";
import { onRouter, onStart, toAgent, toFinish } from "../fixtures/paths.js";
import { TopicsWorkflow } from "../fixtures/topics.fixture.js";

/** Router rules (#272 AC6, #270, #280): routes as sets, input, model. */

const entry = () => onStart(SecondKitWorkflowStart).toRouter(KitRouter);
const editAgain = () => toAgent(EditKitAgent).toRouter(KitRouter);

@Workflow({
  name: "reordered-routes-workflow",
  version: "1.0.0",
  flow: [
    entry(),
    onRouter(KitRouter).onRoute(toFinish(DraftKitWorkflowFinish)).onRoute(editAgain()),
  ],
})
class ReorderedRoutesWorkflow {}

@Workflow({
  name: "mismatched-routes-workflow",
  version: "1.0.0",
  flow: [
    entry(),
    onRouter(KitRouter).onRoute(editAgain()).onRoute(toFinish(SentKitWorkflowFinish)),
  ],
})
class MismatchedRoutesWorkflow {}

@Workflow({
  name: "duplicate-route-workflow",
  version: "1.0.0",
  flow: [
    entry(),
    onRouter(KitRouter)
      .onRoute(toFinish(DraftKitWorkflowFinish))
      .onRoute(toFinish(DraftKitWorkflowFinish))
      .onRoute(editAgain()),
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
  onStart(SecondKitWorkflowStart).toRouter(BlindRouter).onRoute(toFinish(DraftKitWorkflowFinish)),
];

@Workflow({ name: "blind-router-workflow", version: "1.0.0", flow: blindPaths })
class BlindRouterWorkflow {}

@Workflow({
  name: "choose-after-agent-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart).toAgent(DraftKitAgent).onRoute(toFinish(DraftKitWorkflowFinish)),
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
        "mismatched-routes-workflow: kit-router: the flow's routes and @Router({ routes }) differ — not in @Router({ routes }): sent-kit-workflow-finish; missing in .onRoute(…): draft-kit-workflow-finish",
    });
  });

  it("a target listed twice in the flow fails", () => {
    expect(errorsOf(DuplicateRouteWorkflow)).toEqual([
      {
        code: "router.duplicate-route",
        message:
          "duplicate-route-workflow: kit-router: draft-kit-workflow-finish is listed twice in .onRoute(…) — list each target once",
      },
    ]);
  });
});

describe("AC11: router assembly rules — input and model (#270, #280)", () => {
  it("an empty input and a target listed twice in routes fail", () => {
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
    ]);
  });

  it(".onRoute(…) only follows a router", () => {
    expect(errorsOf(ChooseAfterAgentWorkflow)).toContainEqual({
      code: "graph.choose-from-non-router",
      message:
        "choose-after-agent-workflow: draft-kit-agent is not a router — .onRoute(…) follows .toRouter(…) or onRouter(…)",
    });
  });
});

@Router({
  name: "blind-code-router",
  description: "Reads nothing",
  decidedBy: DecidedBy.Code,
  input: {},
  routes: [DraftKitWorkflowFinish],
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
    onStart(SecondKitWorkflowStart)
      .toRouter(BlindCodeRouter)
      .onRoute(toFinish(DraftKitWorkflowFinish)),
  ],
})
class BlindCodeRouterWorkflow {}

@Router({
  name: "promptless-router",
  description: "A route without a prompt",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: inline("Pick one."),
  input: { draft: OfferDraftDto },
  routes: [{ target: DraftKitWorkflowFinish, prompt: " " }],
})
class PromptlessRouter {}

@Workflow({
  name: "promptless-router-workflow",
  version: "1.0.0",
  flow: [
    onStart(SecondKitWorkflowStart)
      .toRouter(PromptlessRouter)
      .onRoute(toFinish(DraftKitWorkflowFinish)),
  ],
})
class PromptlessRouterWorkflow {}

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

  it("a code router with flat routes, one .onRoute(…) each, passes", () => {
    expect(errorsOf(TopicsWorkflow)).toEqual([]);
  });

  it("a model router's route without a prompt fails: the model decides each route by its prompt", () => {
    expect(errorsOf(PromptlessRouterWorkflow)).toEqual([
      {
        code: "router.no-prompt",
        message:
          "promptless-router-workflow: promptless-router: the routes to draft-kit-workflow-finish have no prompt — the model decides each by its prompt; write one",
      },
    ]);
  });
});
