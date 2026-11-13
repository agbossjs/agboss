import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Agent, EmptyEnvironment, Workflow, WorkflowFinish, WorkflowStart } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/**
 * #646 — the documented pattern: two executions started and the clock advanced at once. Each one's
 * agent waits on the clock (`waitFor(seconds(5))`) in its model call, holding one of the instance's
 * two step slots, so readiness is `Degraded` once both have reached that wait.
 */

export class ChunkDraftDto {
  @Text({ prompt: "what the chunk says" })
  summary!: string;
}

@Agent({
  name: "chunk-worker-agent",
  description: "Summarises a chunk",
  prompt: "Summarise the chunk.",
  model: "test/chunk-worker",
  input: { task: WorkflowStartTextDto },
  output: ChunkDraftDto,
})
export class ChunkWorkerAgent {}

@WorkflowStart({ name: "chunk-workflow-start", description: "A chunk", input: WorkflowStartTextDto })
export class ChunkWorkflowStart {}

@WorkflowFinish({ name: "chunk-workflow-finish", description: "Its summary", output: ChunkDraftDto })
export class ChunkWorkflowFinish {}

@Workflow({
  name: "chunk-workflow",
  version: "1.0.0",
  flow: [
    start(ChunkWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ChunkWorkerAgent)
      .returns(ChunkDraftDto)
      .toFinish(ChunkWorkflowFinish),
  ],
})
export class ChunkWorkflow {}

@Application({
  name: "busy-slots-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChunkWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 2,
})
export class BusySlotsApplication {}
