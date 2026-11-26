import { Window1Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import {} from "../../../src/models/index.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  LocalModelProvider,
  TestOpenRouterProvider,
  TestDecisionsProvider,
} from "../providers.fixture.js";

/** #266 AC8: `agboss check --models` on one workflow checks every model of its application. */

const defaults = {
  models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
} as const;

@WorkflowFinish({
  name: "notes-workflow-finish",
  description: "The note",
  output: WorkflowFinishTextDto,
})
export class NotesFinish {}

@Agent({
  name: "drafting-agent",
  prompt: inline("Draft."),
  description: "Drafts",
  model: "local/llama",
  modelProvider: LocalModelProvider,
})
export class DraftingAgent {}

@WorkflowStart({
  name: "drafting-workflow-start",
  description: "A topic",
  input: WorkflowStartTextDto,
})
export class DraftingStart {}

@Workflow({
  name: "drafting-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(DraftingStart)
    .toAgent(DraftingAgent)
    .toFinish(NotesFinish)],
  defaults,
  memory: Window1Memory,
})
export class DraftingWorkflow {}

@Agent({
  name: "polishing-agent",
  prompt: inline("Polish."),
  description: "Polishes",
  model: "moonshotai/kimi-k2.6",
  modelProvider: TestOpenRouterProvider,
})
export class PolishingAgent {}

@WorkflowStart({
  name: "polishing-workflow-start",
  description: "A draft",
  input: WorkflowStartTextDto,
})
export class PolishingStart {}

@Workflow({
  name: "polishing-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(PolishingStart)
    .toAgent(PolishingAgent)
    .toFinish(NotesFinish)],
  defaults,
  memory: Window1Memory,
})
export class PolishingWorkflow {}

@Application({
  name: "notes-application",
  version: "1.0.0",
  workflows: [DraftingWorkflow, PolishingWorkflow],
  providers: [TestOpenRouterProvider, TestDecisionsProvider, LocalModelProvider],
  budgets: TEST_BUDGETS,
})
export class NotesApplication {}
