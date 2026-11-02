import {
  ChildPlacement,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import {
  RemoteChecksWorkflowFinish,
  RemoteItemWorkflow,
} from "../../flow/runtime/fixtures/remote-children.workflow.js";

/**
 * #485 — queued work to measure: `metrics-batch-workflow` launches up to 20 children on any
 * instance at once (`remote-item-workflow`: one action, held at the fixture's gate); the
 * application caps each instance at one step (`maxConcurrentSteps: 1`), so with three instances
 * three children run and the rest wait in the queue. `remote-item-workflow-start` runs one gated
 * action as a root.
 */

@WorkflowStart({
  name: "metrics-batch-workflow-start",
  description: "Items to check, each a child on any instance",
  input: listOf(ItemDto),
})
export class MetricsBatchWorkflowStart {}

@Workflow({
  name: "metrics-batch-workflow",
  version: "1.0.0",
  maxConcurrentExecutions: 30,
  flow: [
    start(MetricsBatchWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(RemoteItemWorkflow, {
        maxConcurrency: 20,
        maxItems: 20,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(RemoteChecksWorkflowFinish),
  ],
})
export class MetricsBatchWorkflow {}

const SHAPE = {
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MetricsBatchWorkflow, RemoteItemWorkflow],
  budgets: TEST_BUDGETS,
} as const;

/** One step at a time per instance. */
@Application({ name: "metrics-application", maxConcurrentSteps: 1, ...SHAPE })
export class MetricsApplication {}

/** One step at a time, its log recorded (`logged`). */
@Application({
  name: "logged-metrics-application",
  maxConcurrentSteps: 1,
  providers: [RecordingLogger],
  ...SHAPE,
})
export class LoggedMetricsApplication {}

/** No cap on steps: no slot gauges. */
@Application({ name: "uncapped-metrics-application", ...SHAPE })
export class UncappedMetricsApplication {}

/** `count` items, all `ok`. */
export const itemsOf = (count: number): ItemDto[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `item-${String(index)}`,
    delay: 0,
    outcome: "ok" as const,
  }));
