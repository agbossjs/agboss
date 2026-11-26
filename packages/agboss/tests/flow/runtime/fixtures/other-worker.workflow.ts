import {
  Action,
  ApplicationContext,
  ChildPlacement,
  StepError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { seconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { onStart, toFinish } from "../../../helpers/flow.js";
import { ItemDto, ItemResultDto } from "./fan-out.workflow.js";

/**
 * #1286 — a child with `ChildPlacement.OtherWorker`: claimed by a worker other than the instance that
 * launched it, and a failure of its parent's step (`StepError.ChildWorkerUnavailable`) when none claims
 * it within `childClaimTimeout` (D9).
 */

/** The instances that ran a child's step. */
export const otherLog = { ranOn: [] as string[] };

@Action({
  name: "other-worker-action",
  description: "Logs where it ran",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ApplicationContext],
})
export class OtherWorkerAction {
  constructor(private readonly application: ApplicationContext) {}

  execute(input: { readonly item: Tracked<ItemDto> }): Promise<ItemResultDto> {
    otherLog.ranOn.push(this.application.instanceId);
    return Promise.resolve({ name: input.item.name });
  }
}

@WorkflowStart({
  name: "other-worker-item-workflow-start",
  description: "One item",
  input: ItemDto,
})
export class OtherWorkerItemWorkflowStart {}

@WorkflowFinish({
  name: "other-worker-item-workflow-finish",
  description: "The item",
  output: ItemResultDto,
})
export class OtherWorkerItemWorkflowFinish {}

@Workflow({
  name: "other-worker-item-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  placement: ChildPlacement.OtherWorker,
  flow: [
    onStart(OtherWorkerItemWorkflowStart)
      .toAction(OtherWorkerAction)
      .toFinish(OtherWorkerItemWorkflowFinish),
  ],
})
export class OtherWorkerItemWorkflow {}

@WorkflowStart({
  name: "other-worker-root-workflow-start",
  description: "One item",
  input: ItemDto,
})
export class OtherWorkerRootWorkflowStart {}

@WorkflowFinish({
  name: "other-worker-unavailable-workflow-finish",
  description: "No other worker took the child",
  output: ItemDto,
})
export class OtherWorkerUnavailableWorkflowFinish {}

/** One OtherWorker child; no other worker within the timeout is caught by `.onError`. */
@Workflow({
  name: "other-worker-root-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OtherWorkerRootWorkflowStart)
      .toWorkflow(OtherWorkerItemWorkflow)
      .onError(StepError, toFinish(OtherWorkerUnavailableWorkflowFinish))
      .toFinish(OtherWorkerItemWorkflowFinish),
  ],
})
export class OtherWorkerRootWorkflow {}

@Application({
  name: "other-worker-application",
  version: "1.0.0",
  workflows: [OtherWorkerRootWorkflow],
  executionLimits: { childClaimTimeout: seconds(5) },
  budgets: TEST_BUDGETS,
})
export class OtherWorkerApplication {}
