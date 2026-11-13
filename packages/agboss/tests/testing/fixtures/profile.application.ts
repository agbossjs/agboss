import {
  Agent,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { DecisionsModelProvider } from "../../../src/models/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";
import { start } from "../../helpers/flow.js";

/** The child's agent: `profiles/profile-kid-workflow/*.yaml` change its settings. */
@Agent({ name: "kid-agent", description: "Answers", prompt: "Answer.", model: "local/llama" })
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
  flow: [start(KidStart).returns(WorkflowStartTextDto).toAgent(Kid).toFinish(KidFinish)],
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
  flow: [
    start(BossStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(KidWorkflow)
      .returns(WorkflowFinishTextDto)
      .toFinish(BossFinish),
  ],
})
export class BossWorkflow {}

@Application({
  name: "profile-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BossWorkflow],
  budgets: TEST_BUDGETS,
  providers: [LocalModelProvider, DecisionsModelProvider],
})
export class ProfileApplication {}
