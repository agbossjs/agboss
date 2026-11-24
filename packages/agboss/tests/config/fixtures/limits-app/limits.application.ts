import { Text } from "../../../../src/dto/index.js";
import {
  Action,
  DecidedBy,
  EmptyEnvironment,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { days, hours } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { WorkflowStartTextDto } from "../../../flow/fixtures/dtos.js";
import { BatchWorkflow } from "../../../flow/runtime/fixtures/tree-batch.workflow.js";
import { CountdownWorkflow } from "../../../flow/runtime/fixtures/recursion.workflow.js";
import { onAction, onStart, route } from "../../../helpers/flow.js";

/**
 * #1318c: the workflows whose limits and history keep-time the profiles of this directory change —
 * a loop of actions bounded by `maxSteps` (the action counts as a step, #1278b), a recursion bounded
 * by `maxDepth` and a tree whose cap is `maxConcurrency` (the last two are the fixtures of #264), and a workflow
 * whose history is kept for 90 days.
 */

export class LimitsDto {
  @Text({ prompt: "the spin" })
  text!: string;
}

@WorkflowStart({
  name: "limits-spin-workflow-start",
  description: "A spin",
  input: WorkflowStartTextDto,
})
export class LimitsSpinStart {}

@Action({
  name: "limits-spin-action",
  description: "Does one turn",
  input: { message: WorkflowStartTextDto },
  output: LimitsDto,
})
export class LimitsSpinAction {
  async execute(): Promise<LimitsDto> {
    return { text: "again" };
  }
}

@WorkflowFinish({ name: "limits-spin-workflow-finish", description: "Done", output: LimitsDto })
export class LimitsSpinFinish {}

/** Always turns again: only `maxVisits` (100) and `maxSteps` end the loop. */
@Router({
  name: "limits-spin-router",
  description: "Turns again",
  decidedBy: DecidedBy.Code,
  maxVisits: 100,
  input: { spin: LimitsDto },
  routes: [{ target: LimitsSpinAction }, { target: LimitsSpinFinish }],
})
export class LimitsSpinRouter {
  route(): unknown {
    return LimitsSpinAction;
  }
}

/** Declares 40 steps: a loop of an action and a router runs 20 turns before the limit stops it. */
@Workflow({
  name: "limits-spin-workflow",
  version: "1.0.0",
  executionLimits: { maxSteps: 40 },
  flow: [
    onStart(LimitsSpinStart).toAction(LimitsSpinAction),
    onAction(LimitsSpinAction)
      .toRouter(LimitsSpinRouter)
      .chooseOne(route(LimitsSpinAction), route(LimitsSpinFinish)),
  ],
})
export class LimitsSpinWorkflow {}

@WorkflowStart({
  name: "limits-kept-workflow-start",
  description: "A note",
  input: WorkflowStartTextDto,
})
export class LimitsKeptStart {}

@Action({
  name: "limits-kept-action",
  description: "Writes the note",
  input: { message: WorkflowStartTextDto },
  output: LimitsDto,
})
export class LimitsKeptAction {
  async execute(): Promise<LimitsDto> {
    return { text: "written" };
  }
}

@WorkflowFinish({ name: "limits-kept-workflow-finish", description: "Done", output: LimitsDto })
export class LimitsKeptFinish {}

/** Its history is kept for 90 days. */
@Workflow({
  name: "limits-kept-workflow",
  version: "1.0.0",
  historyTtl: days(90),
  flow: [onStart(LimitsKeptStart).toAction(LimitsKeptAction).toFinish(LimitsKeptFinish)],
})
export class LimitsKeptWorkflow {}

@Application({
  name: "limits-config-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LimitsSpinWorkflow, LimitsKeptWorkflow, CountdownWorkflow, BatchWorkflow],
  retention: { executionRecords: hours(24) },
  budgets: TEST_BUDGETS,
})
export class LimitsApplication {}

export { BatchWorkflow, CountdownWorkflow };
