import {
  Agent,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Application } from "../../../../src/application/application.js";
import {} from "../../../../src/models/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { LocalModelProvider, TestDecisionsProvider } from "../../../models/providers.fixture.js";
import { onStart } from "../../../helpers/flow.js";

/** The child's agent: `config/*.config.yaml` change its settings (`workflows.profile-kid-workflow.agents`). */
@Agent({
  name: "kid-agent",
  description: "Answers",
  prompt: inline("Answer."),
  model: "local/llama",
  modelProvider: LocalModelProvider,
})
export class Kid {}

@WorkflowStart({
  name: "kid-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
class KidStart {}

@WorkflowFinish({
  name: "kid-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
class KidFinish {}

@Workflow({
  name: "profile-kid-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(KidStart).toAgent(Kid).toFinish(KidFinish)],
})
export class KidWorkflow {}

@WorkflowStart({ name: "boss-workflow-start", description: "A task", input: WorkflowStartTextDto })
class BossStart {}

@WorkflowFinish({
  name: "boss-workflow-finish",
  description: "The result",
  output: WorkflowFinishTextDto,
})
class BossFinish {}

/** Launches `KidWorkflow`, which its application does not list. */
@Workflow({
  name: "profile-boss-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(BossStart).toWorkflow(KidWorkflow).toFinish(BossFinish)],
})
export class BossWorkflow {}

@Application({
  name: "profile-application",
  version: "1.0.0",
  workflows: [BossWorkflow],
  budgets: TEST_BUDGETS,
  providers: [LocalModelProvider, TestDecisionsProvider],
})
export class ProfileApplication {}
