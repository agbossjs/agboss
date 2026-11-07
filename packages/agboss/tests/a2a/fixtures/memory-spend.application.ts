// #844 — an application whose agent's own memory strategy pays for its update after every
// finished turn: a spend the end event reports and the checkpoint never holds.
import { Application } from "../../../src/application/application.js";
import { serviceUsageOf } from "../../../src/components/spend-recorder.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import {
  BaseMemoryStrategy,
  type MemoryContext,
  type MemoryUpdate,
  type MemoryView,
} from "../../../src/memory/index.js";
import { usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/** What one memory update costs. */
export const MEMORY_UPDATE_COST = 0.5;

/** Sees the thread as the built-in window does; pays `MEMORY_UPDATE_COST` to update its memory. */
@Injectable()
export class PaidMemoryStrategy extends BaseMemoryStrategy {
  buildContext(context: MemoryContext): MemoryView {
    return { summaries: context.summaries, history: context.history };
  }

  override updateMemory(): Promise<MemoryUpdate> {
    return Promise.resolve({
      usage: [serviceUsageOf({ service: "memory-service", cost: usd(MEMORY_UPDATE_COST) })],
    });
  }
}

@Agent({
  name: "memo-agent",
  description: "Answers and remembers, at a price",
  prompt: "Answer.",
  model: "test/memo",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  memoryStrategy: PaidMemoryStrategy,
})
export class MemoAgent {}

@WorkflowStart({
  name: "memo-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
export class MemoStart {}

@WorkflowFinish({
  name: "memo-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class MemoFinish {}

@Workflow({
  name: "memo-workflow",
  version: "1.0.0",
  flow: [start(MemoStart).returns(WorkflowStartTextDto).toAgent(MemoAgent).toFinish(MemoFinish)],
})
export class MemoWorkflow {}

@Application({
  name: "memo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MemoWorkflow],
  budgets: TEST_BUDGETS,
})
export class MemoApplication {}
