import { Window2Memory, Window4Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  CompactionStrategy,
  Memory,
  NoMemory,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  TokenLimit,
  inline,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {} from "../../../src/models/index.js";
import { LocalModelProvider, TestDecisionsProvider } from "../../models/providers.fixture.js";
import { onStart } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** What the recaller recalled. */
export class RecallDto {
  @Text({ prompt: "what was recalled" })
  text!: string;
}

/** What the windowed agent saw. */
export class WindowDto {
  @Text({ prompt: "what the window shows" })
  text!: string;
}

@Agent({
  name: "recaller-agent",
  prompt: inline("Recall."),
  description: "Recalls",
  model: "local/llama",
  modelProvider: LocalModelProvider,
  input: { message: WorkflowStartTextDto },
  output: RecallDto,
})
export class Recaller {}

@Agent({
  name: "windowed-agent",
  prompt: inline("Window."),
  description: "Sees two turns",
  model: "local/llama",
  modelProvider: LocalModelProvider,
  memory: Window2Memory,
  input: { recall: RecallDto },
  output: WindowDto,
})
export class Windowed {}

@Agent({
  name: "noter-agent",
  prompt: inline("Note."),
  description: "Opts out of the workflow's memory",
  model: "local/llama",
  modelProvider: LocalModelProvider,
  memory: NoMemory,
  input: { window: WindowDto },
})
export class Noter {}

@WorkflowStart({ name: "task-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class TaskStart {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class Answer {}

@WorkflowFinish({ name: "recalled-workflow-finish", description: "The recall", output: RecallDto })
export class Recalled {}

const DEFAULTS = {
  models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
  tools: { maxToolCalls: 2 },
} as const;

/** The model providers of both applications (#266): Jev's decisions, the local chat models. */
const MODEL_PROVIDERS = [TestDecisionsProvider, LocalModelProvider];

/** Three agents in a line: the built-in window (4 turns), a window of its own (2), no memory. */
@Workflow({
  name: "memory-desk-workflow",
  version: "1.0.0",
  flow: [
    onStart(TaskStart)
      .toAgent(Recaller)
      .toAgent(Windowed)
      .toAgent(Noter)
      .toFinish(Answer),
  ],
  defaults: DEFAULTS,
  memory: Window4Memory,
})
export class MemoryDesk {}

@Application({
  name: "memory-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MemoryDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class MemoryDeskApplication {}

/** Every 2 turns older than the window become one summary; the latest 3 are kept. */
@Memory({
  name: "desk-memory",
  description: "Summarises the desk's old turns",
  ttl: Ttl.Forever,
  uncompactedTurns: 1,
  turnsBetweenCompactions: 2,
  compaction: {
    strategy: CompactionStrategy.SummaryQueue,
    model: "local/llama",
    summaryQueueLength: 3,
    summaryMaxTokens: 200,
  },
})
export class DeskMemory {}

/** One agent with a window of 1 turn; older turns are compacted by a priced model. */
@Workflow({
  name: "compacting-desk-workflow",
  version: "1.0.0",
  flow: [
    onStart(TaskStart)
      .toAgent(Recaller)
      .toFinish(Recalled),
  ],
  defaults: DEFAULTS,
  memory: DeskMemory,
})
export class CompactingDesk {}

@Application({
  name: "compacting-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CompactingDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class CompactingDeskApplication {}
