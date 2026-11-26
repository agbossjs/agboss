import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { describe, expect } from "vitest";
import { Text } from "../../../src/dto/index.js";
import {
  Action,
  DecidedBy,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { testWith } from "../../../src/testing/index.js";
import { execute, onAction, onStart, toAction, toFinish } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../fixtures/budgets.js";
import { WorkflowStartTextDto } from "../fixtures/dtos.js";

/**
 * #1278b (D8): an action and an external task count toward `maxSteps`, like an agent and a router.
 * A loop through an action is bounded by `maxSteps`, not only by the router's `maxVisits`.
 */

class SpinDto {
  @Text({ prompt: "the spin" })
  text!: string;
}

@WorkflowStart({
  name: "spin-start-workflow-start",
  description: "A topic",
  input: WorkflowStartTextDto,
})
class SpinStart {}

@Action({
  name: "spin-action",
  description: "Does one turn",
  input: { message: WorkflowStartTextDto },
  output: SpinDto,
})
class SpinAction {
  async execute(): Promise<SpinDto> {
    return { text: "again" };
  }
}

@WorkflowFinish({ name: "spin-finish-workflow-finish", description: "Done", output: SpinDto })
class SpinFinish {}

@WorkflowFinish({
  name: "spin-recovered-finish-workflow-finish",
  description: "Gave up",
  output: SpinDto,
})
class SpinRecoveredFinish {}

@Action({
  name: "spin-recover-action",
  description: "Reacts to the steps limit",
  input: { message: WorkflowStartTextDto },
  output: SpinDto,
})
class SpinRecoverAction {
  async execute(): Promise<SpinDto> {
    return { text: "recovered" };
  }
}

/** Always turns again: only `maxVisits` (100) and `maxSteps` end the loop. */
@Router({
  name: "spin-router",
  description: "Turns again",
  decidedBy: DecidedBy.Code,
  maxVisits: 100,
  input: { spin: SpinDto },
  routes: [SpinAction, SpinFinish],
})
class SpinRouter {
  route(): unknown {
    return SpinAction;
  }
}

const loop = [
  onStart(SpinStart).toAction(SpinAction),
  onAction(SpinAction)
    .toRouter(SpinRouter)
    .onRoute(toAction(SpinAction))
    .onRoute(toFinish(SpinFinish)),
];

/** No `maxSteps`: the default is (1 action + 1 router) × 3 = 6. */
@Workflow({ name: "spin-default-workflow", version: "1.0.0", historyTtl: Ttl.Forever, flow: loop })
class SpinDefaultWorkflow {}

@Workflow({
  name: "spin-short-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 5 },
  flow: loop,
})
class SpinShortWorkflow {}

/** The router takes the steps limit into an action: it runs past the limit it reacts to. */
@Workflow({
  name: "spin-recovering-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 5 },
  flow: [
    onStart(SpinStart).toAction(SpinAction),
    onAction(SpinAction)
      .toRouter(SpinRouter)
      .onError(LimitError.Steps, toAction(SpinRecoverAction).toFinish(SpinRecoveredFinish))
      .onRoute(toAction(SpinAction))
      .onRoute(toFinish(SpinFinish)),
  ],
})
class SpinRecoveringWorkflow {}

const applicationOf = (workflow: typeof SpinDefaultWorkflow) => {
  @Application({
    name: "spin-application",
    version: "1.0.0",
    workflows: [workflow],
    budgets: TEST_BUDGETS,
  })
  class SpinApplication {}
  return SpinApplication;
};

const defaulted = testWith(applicationOf(SpinDefaultWorkflow));
const short = testWith(applicationOf(SpinShortWorkflow));
const recovering = testWith(applicationOf(SpinRecoveringWorkflow));

describe("#1278b: actions count toward maxSteps", () => {
  short(
    "a loop through an action stops at maxSteps, far below the router's maxVisits",
    async ({ app }) => {
      const run = execute(app, SpinStart, { text: "go" });

      await expect(run).rejects.toBeInstanceOf(LimitError.Steps);
      await expect(run).rejects.toMatchObject({
        maxSteps: 5,
        steps: 6,
        path: [
          "spin-start-workflow-start",
          "spin-action",
          "spin-router",
          "spin-action",
          "spin-router",
          "spin-action",
          "spin-router",
        ],
      });
    },
  );

  defaulted("the default is (agents + routers + actions + external tasks) × 3", async ({ app }) => {
    const run = execute(app, SpinStart, { text: "go" });

    await expect(run).rejects.toMatchObject({ code: "limit.steps", maxSteps: 6, steps: 7 });
  });

  recovering("the action that reacts to the steps limit is no step past it", async ({ app }) => {
    const result = await execute(app, SpinStart, { text: "go" });

    expect(result).toFinishWith(SpinRecoveredFinish, { text: "recovered" });
  });
});
