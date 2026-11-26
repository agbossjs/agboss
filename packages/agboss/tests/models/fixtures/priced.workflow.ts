import { Window2Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  Workflow,
  TokenLimit,
  WorkflowFinish,
  WorkflowStart,
  Ttl,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Reasoning } from "../../../src/models/index.js";
import { onStart } from "../../helpers/flow.js";
import {
  LocalModelProvider,
  TestOpenRouterProvider,
  TestDecisionsProvider,
} from "../providers.fixture.js";
import { Application } from "../../../src/application/application.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { Budget, BudgetScope, type BudgetHandler } from "../../../src/budgets/budget.js";
import { usd, type Usd } from "../../../src/units/index.js";

/** The summariser's summary: the writer reads it. */
export class SummaryDto {
  @Text({ prompt: "the summary" })
  text!: string;
}

/** Priced by its provider's table (local/llama), no price of its own. */
@Agent({
  name: "summariser-agent",
  prompt: "./summariser.prompt.md",
  description: "Summarises the task",
  model: "local/llama",
  modelProvider: LocalModelProvider,
  input: { task: WorkflowStartTextDto },
  output: SummaryDto,
})
export class Summariser {}

/** Priced by its provider's replyWith (OpenRouter's usage.cost). */
@Agent({
  name: "writer-agent",
  prompt: "./writer.prompt.md",
  description: "Writes the replyWith",
  model: "moonshotai/kimi-k2.6",
  modelProvider: TestOpenRouterProvider,
  reasoning: Reasoning.off(),
  input: { summary: SummaryDto },
})
export class Writer {}

@WorkflowStart({ name: "task-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class TaskStart {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class Answer {}

/** A straight line over two providers: a local server with a price table, and OpenRouter. */
@Workflow({
  name: "priced-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart).toAgent(Summariser).toAgent(Writer).toFinish(Answer)],
  defaults: {
    models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
    tools: { maxToolCalls: 2 },
  },
  memory: Window2Memory,
})
export class Priced {}

/** $0.05 an execution: a dear summary spends it. */
@Budget({ name: "priced-execution-budget", scope: BudgetScope.Execution })
export class PricedExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

@Application({
  name: "priced-application",
  version: "1.0.0",
  workflows: [Priced],
  providers: [TestOpenRouterProvider, TestDecisionsProvider, LocalModelProvider],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, PricedExecutionBudget],
})
export class PricedApplication {}
