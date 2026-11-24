import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import {
  DraftKitWorkflowFinish,
  EditKitAgent,
  PolishKitAgent,
  SecondKitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { onStart, toAction, toFinish } from "../fixtures/paths.js";
import { supportPaths } from "../fixtures/support.fixture.js";
import { Ttl } from "../../../src/index.js";

/** `maxSteps` bounds at assembly (#261 AC17): agent, router, action and external-task visits, only a hand-set value. */

const supportWith = (maxSteps?: number): abstract new () => unknown => {
  @Workflow({
    name: "support-steps-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: supportPaths,
    ...(maxSteps === undefined ? {} : { executionLimits: { maxSteps } }),
  })
  class SupportStepsWorkflow {}
  return SupportStepsWorkflow;
};

const actionsOnlyWith = (maxSteps: number): abstract new () => unknown => {
  @Workflow({
    name: "send-offer-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    executionLimits: { maxSteps },
    flow: [onStart(SecondKitWorkflowStart).toAction(SendKitAction).toFinish(SentKitWorkflowFinish)],
  })
  class SendOfferWorkflow {}
  return SendOfferWorkflow;
};

@Workflow({
  name: "steps-handler-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 1 },
  flow: [
    onStart(SecondKitWorkflowStart)
      .toAgent(EditKitAgent)
      .toAgent(PolishKitAgent)
      .onError(LimitExceededError, toFinish(DraftKitWorkflowFinish))
      .toFinish(DraftKitWorkflowFinish),
  ],
})
class StepsHandlerWorkflow {}

const errorsOf = (workflow: abstract new () => unknown) =>
  checkWorkflow(workflow).errors.map(({ code, message }) => ({ code, message }));

describe("#261 AC17: maxSteps bounds", () => {
  it("the default maxSteps never triggers a bound", () => {
    expect(errorsOf(supportWith())).toEqual([]);
  });

  it("maxSteps below the shortest way from a start to a finish fails", () => {
    expect(errorsOf(supportWith(1))).toEqual([
      {
        code: "limits.max-steps-too-low",
        message:
          "support-steps-workflow: the shortest path from support-workflow-start takes 4 steps, but maxSteps is 1",
      },
    ]);
  });

  it("a node every path through which is too long fails, while a shorter branch finishes", () => {
    expect(errorsOf(supportWith(4))).toEqual([
      {
        code: "limits.branch-exceeds-max-steps",
        message:
          "support-steps-workflow: every path through loyalty-agent takes at least 5 steps, but maxSteps is 4",
      },
    ]);
  });

  it("a path ending in a handler of the steps limit counts as reaching a finish", () => {
    expect(errorsOf(StepsHandlerWorkflow)).toEqual([]);
  });

  it("an action is a step: maxSteps: 0 on a flow of one action is too low, 1 fits it (#1278)", () => {
    expect(errorsOf(actionsOnlyWith(0))).toEqual([
      {
        code: "limits.max-steps-too-low",
        message:
          "send-offer-workflow: the shortest path from second-kit-workflow-start takes 1 steps, but maxSteps is 0",
      },
    ]);
    expect(errorsOf(actionsOnlyWith(1))).toEqual([]);
  });

  it("maxSteps on a flow with no step at all is unused", () => {
    @Workflow({
      name: "empty-steps-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      executionLimits: { maxSteps: 4 },
      flow: [onStart(SecondKitWorkflowStart).toFinish(DraftKitWorkflowFinish)],
    })
    class EmptyStepsWorkflow {}

    expect(errorsOf(EmptyStepsWorkflow)).toEqual([
      {
        code: "limits.max-steps-unused",
        message:
          "empty-steps-workflow has executionLimits.maxSteps: 4, but it has no agent, router, action or external task — steps are always 0; remove maxSteps",
      },
    ]);
  });
});

class ReactionError extends Error {}

@Action({ name: "extra-1-action", description: "A reaction" })
class Extra1Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "extra-2-action", description: "A reaction to the reaction" })
class Extra2Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "extra-3-action", description: "A reaction to that" })
class Extra3Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

/** One agent (0.1.0 allowed 3 steps) and three actions of nested reactions: 4 steps at worst. */
const reactingWith = (maxSteps?: number): abstract new () => unknown => {
  @Workflow({
    name: "reacting-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    ...(maxSteps === undefined ? {} : { executionLimits: { maxSteps } }),
    flow: [
      onStart(SecondKitWorkflowStart)
        .toAgent(EditKitAgent)
        .onError(
          ReactionError,
          toAction(Extra1Action)
            .onError(
              ReactionError,
              toAction(Extra2Action)
                .onError(ReactionError, toAction(Extra3Action).toFinish(DraftKitWorkflowFinish))
                .toFinish(DraftKitWorkflowFinish),
            )
            .toFinish(DraftKitWorkflowFinish),
        )
        .toFinish(DraftKitWorkflowFinish),
    ],
  })
  class ReactingWorkflow {}
  return ReactingWorkflow;
};

describe("#1278b: [limits.max-steps-above-0.1.0-default]", () => {
  const warningsOf = (workflow: abstract new () => unknown) =>
    checkWorkflow(workflow)
      .warnings.filter((found) => found.code === "limits.max-steps-above-0.1.0-default")
      .map(({ message }) => message);

  it("a flow that relies on the default and takes more steps than 0.1.0's default allowed warns", () => {
    expect(warningsOf(reactingWith())).toEqual([
      "reacting-workflow: the worst case from second-kit-workflow-start takes 4 steps, more than the 3 that 0.1.0's default maxSteps — (agents + routers) × 3 — allowed: actions and external tasks count as steps now, and the default is 12. Set @Workflow({ executionLimits: { maxSteps } }) to choose the bound",
    ]);
  });

  it("is an error under --strict", () => {
    expect(
      checkWorkflow(reactingWith(), { strict: true }).errors.map((found) => found.code),
    ).toContain("limits.max-steps-above-0.1.0-default");
  });

  it("a hand-set maxSteps chooses the bound: no warning", () => {
    expect(warningsOf(reactingWith(8))).toEqual([]);
  });

  it("a flow with no agent or router had no steps in 0.1.0: nothing to tell", () => {
    @Workflow({
      name: "only-actions-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [
        onStart(SecondKitWorkflowStart).toAction(SendKitAction).toFinish(SentKitWorkflowFinish),
      ],
    })
    class OnlyActionsWorkflow {}

    expect(warningsOf(OnlyActionsWorkflow)).toEqual([]);
  });
});
