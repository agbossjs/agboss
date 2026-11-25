import { StepError } from "../../../../src/core/error-families/step-errors.js";
import { LimitError } from "../../../../src/core/error-families/limit-errors.js";
import { EmptyEnvironment, Workflow, Ttl } from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { onStart, toAction } from "../../../helpers/flow.js";
import { skip } from "../../../../src/flow/builder.js";
import {
  FanOutLog,
  ItemsFailedAction,
  ItemsFailedWorkflowFinish,
  ItemsWorkflowStart,
  ProcessItemAction,
  SummaryAction,
  SummaryWorkflowFinish,
} from "./fan-out.workflow.js";

/** #1280 — `.forEachItem(step, { maxItems | takeFirst, maxConcurrency })` over the fan-out's items. */

/** The first three items run, two at a time; a failed item is skipped. */
@Workflow({
  name: "take-first-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ItemsWorkflowStart)
      .forEachItem(toAction(ProcessItemAction).onError(StepError, skip()), {
        takeFirst: 3,
        maxConcurrency: 2,
      })
      .join()
      .toAction(SummaryAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class TakeFirstWorkflow {}

@Application({
  name: "take-first-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TakeFirstWorkflow],
  observers: [FanOutLog],
  budgets: TEST_BUDGETS,
})
export class TakeFirstApplication {}

/** At most three items: more throws LimitError.Items before any item runs. */
@Workflow({
  name: "max-items-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ItemsWorkflowStart)
      .forEachItem(toAction(ProcessItemAction), { maxItems: 3 })
      .join()
      .onError(LimitError.Items, toAction(ItemsFailedAction).toFinish(ItemsFailedWorkflowFinish))
      .toAction(SummaryAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class MaxItemsWorkflow {}

@Application({
  name: "max-items-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MaxItemsWorkflow],
  budgets: TEST_BUDGETS,
})
export class MaxItemsApplication {}
