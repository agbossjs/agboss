import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { CompanyCheckDto } from "./launch-dtos.js";
import {
  RankerAgent,
  RankingWorkflowFinish,
  ScreeningAgent,
  ScreeningWorkflowStart,
} from "./launch.fixture.js";
import { onStart, toAgent } from "./paths.js";
import { inline, Ttl } from "../../../src/index.js";
/**
 * #273 — a per-item launch whose target reads no item (`[launch.item-not-read]`): its generated
 * `InputOf` is the rule's message, so the typed builder refuses `.inParallel(ItemBlindAgent)`.
 * Written with the untyped helpers — the typed builder would not let it compile.
 */
@Agent({
  name: "item-blind-agent",
  description: "Checks a company without reading it",
  prompt: inline("Check the company."),
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ScreeningWorkflowStart)
      .toAgent(ScreeningAgent)
      .forEachItem(toAgent(ItemBlindAgent), { takeFirst: 5 })
      .join()
      .toAgent(RankerAgent)
      .toFinish(RankingWorkflowFinish),
  ],
})
export class BrokenScreeningWorkflow {}
