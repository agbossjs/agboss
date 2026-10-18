import {
  Agent,
  EmptyEnvironment,
  MODEL_MAX,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { DecisionsModelProvider } from "../../../src/models/index.js";
import { start } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { LocalModelProvider, TestOpenRouterProvider } from "../providers.fixture.js";

/** #266 AC8: `agboss check --models` on one workflow checks every model of its application. */

const defaults = {
  models: { temperature: 0, maxTokens: MODEL_MAX },
  router: { model: "typesafe/jev-1.13" },
  history: { limit: 1 },
} as const;

@WorkflowFinish({ name: "notes-workflow-finish", description: "The note", output: WorkflowFinishTextDto })
export class NotesFinish {}

@Agent({ name: "drafting-agent", prompt: "Draft.", description: "Drafts", model: "local/llama" })
export class DraftingAgent {}

@WorkflowStart({ name: "drafting-workflow-start", description: "A topic", input: WorkflowStartTextDto })
export class DraftingStart {}

@Workflow({
  name: "drafting-workflow",
  version: "1.0.0",
  flow: [
    start(DraftingStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DraftingAgent)
      .toFinish(NotesFinish),
  ],
  defaults,
})
export class DraftingWorkflow {}

@Agent({
  name: "polishing-agent",
  prompt: "Polish.",
  description: "Polishes",
  model: "moonshotai/kimi-k2.6",
})
export class PolishingAgent {}

@WorkflowStart({ name: "polishing-workflow-start", description: "A draft", input: WorkflowStartTextDto })
export class PolishingStart {}

@Workflow({
  name: "polishing-workflow",
  version: "1.0.0",
  flow: [
    start(PolishingStart)
      .returns(WorkflowStartTextDto)
      .toAgent(PolishingAgent)
      .toFinish(NotesFinish),
  ],
  defaults,
})
export class PolishingWorkflow {}

@Application({
  name: "notes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DraftingWorkflow, PolishingWorkflow],
  providers: [TestOpenRouterProvider, DecisionsModelProvider, LocalModelProvider],
  budgets: TEST_BUDGETS,
})
export class NotesApplication {}
