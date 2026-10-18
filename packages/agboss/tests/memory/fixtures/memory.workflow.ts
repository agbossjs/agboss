import {
  Agent,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
  MODEL_MAX,
} from "../../../src/index.js";
import { InjectionToken, provide } from "../../../src/components/injection.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  BaseMemoryStrategy,
  SlidingWindowStrategy,
  type MemoryContext,
  type MemoryTurn,
  type MemoryUpdate,
  type MemoryView,
} from "../../../src/memory/index.js";
import { DecisionsModelProvider } from "../../../src/models/index.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

/** Where the noting strategy keeps what it saw (a provider value, so tests read it). */
export const NOTES = new InjectionToken<string[]>("NOTES");
export const NOTED: string[] = [];

/** A custom strategy with a dependency: sees no summaries, the last turn only; notes every turn. */
@Injectable({ deps: [NOTES] })
export class NotingStrategy extends BaseMemoryStrategy {
  constructor(private readonly notes: string[]) {
    super();
  }

  buildContext({ history }: MemoryContext): MemoryView {
    return { summaries: [], history: history.slice(-1) };
  }

  override updateMemory({ turn }: MemoryTurn): Promise<MemoryUpdate> {
    this.notes.push(turn.start);
    return Promise.resolve({});
  }
}

/** A fixed sliding window of two turns. */
export class LastTwoTurns extends SlidingWindowStrategy {
  constructor() {
    super({ turns: 2 });
  }
}

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
  prompt: "Recall.",
  description: "Recalls",
  model: "local/llama",
  input: { message: WorkflowStartTextDto },
  output: RecallDto,
})
export class Recaller {}

@Agent({
  name: "windowed-agent",
  prompt: "Window.",
  description: "Sees two turns",
  model: "local/llama",
  memoryStrategy: LastTwoTurns,
  input: { recall: RecallDto },
  output: WindowDto,
})
export class Windowed {}

@Agent({
  name: "noter-agent",
  prompt: "Note.",
  description: "Uses its own strategy",
  model: "local/llama",
  memoryStrategy: NotingStrategy,
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
  models: { temperature: 0, maxTokens: MODEL_MAX },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 2 },
  history: { limit: 4 },
} as const;

const settings = (): WorkflowSettings =>
  WorkflowSettings.builder()
    .modelProviders([DecisionsModelProvider, LocalModelProvider])
    .defaultModelProvider(LocalModelProvider)
    .build();

/** Three agents in a line: the built-in window (4 turns), a fixed window (2), a custom strategy. */
@Workflow({
  name: "memory-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Recaller)
      .returns(RecallDto)
      .toAgent(Windowed)
      .returns(WindowDto)
      .toAgent(Noter)
      .toFinish(Answer),
  ],
  defaults: DEFAULTS,
  providers: [provide(NOTES, NOTED)],
})
export class MemoryDesk implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return settings();
  }
}

@Application({
  name: "memory-desk-application",
  version: "1.0.0",
  workflows: [MemoryDesk],
  budgets: TEST_BUDGETS,
})
export class MemoryDeskApplication {}

/** One agent; every 2 turns are compacted by a priced model. */
@Workflow({
  name: "compacting-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Recaller)
      .returns(RecallDto)
      .toFinish(Recalled),
  ],
  defaults: DEFAULTS,
  compaction: { every: 2, keep: 3, model: { model: "local/llama" } },
})
export class CompactingDesk implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return settings();
  }
}

@Application({
  name: "compacting-desk-application",
  version: "1.0.0",
  workflows: [CompactingDesk],
  budgets: TEST_BUDGETS,
})
export class CompactingDeskApplication {}
