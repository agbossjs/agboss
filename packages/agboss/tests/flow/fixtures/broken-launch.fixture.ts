import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { listOf } from "../../../src/flow/dto-wrappers.js";
import { CompanyDto } from "./data-dtos.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { CompanyCheckDto, RankingDto } from "./launch-dtos.js";
import {
  RankerAgent,
  RankingWorkflowFinish,
  ScreeningAgent,
  ScreeningWorkflowStart,
} from "./launch.fixture.js";
import { start } from "./paths.js";
/**
 * #273 — a per-item launch whose target reads no item (`[launch.item-not-read]`): its generated
 * `InputOf` is the rule's message, so the typed builder refuses `.toParallelAgents(ItemBlindAgent)`.
 * Written with the untyped helpers — the typed builder would not let it compile.
 */
@Agent({
  name: "item-blind-agent",
  description: "Checks a company without reading it",
  prompt: "Check the company.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: CompanyCheckDto,
})
export class ItemBlindAgent {}

@Workflow({
  name: "broken-screening-workflow",
  version: "1.0.0",
  flow: [
    start(ScreeningWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ScreeningAgent)
      .returns(listOf(CompanyDto))
      .toParallelAgents(ItemBlindAgent, { maxItems: 5 })
      .join()
      .returns(listOf(CompanyCheckDto))
      .toAgent(RankerAgent)
      .returns(RankingDto)
      .toFinish(RankingWorkflowFinish),
  ],
})
export class BrokenScreeningWorkflow {}
