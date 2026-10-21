import { Text, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  Action,
  Agent,
  ExecutionContext,
  SpendRecorder,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../../src/index.js";
import { seconds, usd, type Usd } from "../../../../src/units/index.js";
import { start } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import {
  TEST_BUDGETS,
  TestApplicationDailyBudget,
  TestTenantDailyBudget,
} from "../../fixtures/budgets.js";
import { Budget, BudgetScope, type BudgetHandler } from "../../../../src/budgets/budget.js";
import { EmptyEnvironment } from "../../../../src/index.js";

/** What the components saw (reset by `resetSpendSeen`). */
export const spendSeen = {
  /** Why each slow call's signal aborted (the reason's class name). */
  aborts: [] as string[],
  /** Whether the action's step signal was aborted when it ran. */
  actionSignalAborted: [] as boolean[],
};

/** The test's hook: called when a slow call has started waiting (its timeout runs on the clock). */
export const spendHooks: { fetchStarted?: () => void } = {};

export function resetSpendSeen(): void {
  spendSeen.aborts.length = 0;
  spendSeen.actionSignalAborted.length = 0;
  delete spendHooks.fetchStarted;
}

export class SearchDto {
  @Text({ prompt: "what to search" })
  query!: string;
}

export class ResultDto {
  @Text({ prompt: "what was found" })
  text!: string;
}

/** A paid search API (not a model): each call records its price. */
@Tool({
  name: "serp-search-tool",
  description: "Searches the web (paid)",
  input: SearchDto,
  output: SearchDto,
  deps: [SpendRecorder],
})
export class SerpSearchTool implements ToolHandler<SearchDto, SearchDto> {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  run(input: SearchDto): Promise<SearchDto> {
    this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) });
    return Promise.resolve(input);
  }
}

/** Waits on its call's signal like a fetch would; records why it was aborted. */
@Tool({
  name: "slow-fetch-tool",
  description: "Fetches slowly",
  input: SearchDto,
  output: SearchDto,
  timeout: seconds(0.05),
  deps: [ExecutionContext],
})
export class SlowFetchTool implements ToolHandler<SearchDto, SearchDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: SearchDto): Promise<SearchDto> {
    const { signal } = this.executionContext;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const reason: unknown = signal.reason;
        spendSeen.aborts.push(reason instanceof Error ? reason.name : String(reason));
        reject(reason instanceof Error ? reason : new Error("aborted"));
      });
      if (input.query === "never") resolve(input);
      spendHooks.fetchStarted?.();
    });
  }
}

/** Pays a delivery service (not a model) and reads its step's signal. */
@Action({
  name: "ship-action",
  description: "Ships the result",
  input: { result: ResultDto },
  output: ResultDto,
  deps: [SpendRecorder, ExecutionContext],
})
export class ShipAction {
  constructor(
    private readonly spendRecorder: SpendRecorder,
    private readonly executionContext: ExecutionContext,
  ) {}

  execute(input: { readonly result: { readonly value: ResultDto } }): Promise<ResultDto> {
    spendSeen.actionSignalAborted.push(this.executionContext.signal.aborted);
    this.spendRecorder.record({ service: "courier-api", cost: usd(0.003) });
    return Promise.resolve(input.result.value);
  }
}

@Agent({
  name: "searcher-agent",
  description: "Searches",
  prompt: "Search.",
  model: "test/searcher",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  tools: [SerpSearchTool, SlowFetchTool],
  input: { message: WorkflowStartTextDto },
  output: ResultDto,
})
export class SearcherAgent {}

@WorkflowStart({
  name: "spend-workflow-start",
  description: "A query",
  input: WorkflowStartTextDto,
})
export class SpendStart {}

@WorkflowFinish({ name: "shipped-workflow-finish", description: "Shipped", output: ResultDto })
export class ShippedFinish {}

const paths = [
  start(SpendStart)
    .returns(WorkflowStartTextDto)
    .toAgent(SearcherAgent)
    .returns(ResultDto)
    .toAction(ShipAction)
    .returns(ResultDto)
    .toFinish(ShippedFinish),
];

/** start → searcher (paid search) → ship (paid courier) → shipped; the test budgets ($100 an execution). */
@Workflow({ name: "spend-workflow", version: "1.0.0", providers: [ShipAction], flow: paths })
export class SpendWorkflow {}

@Application({
  name: "spend-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SpendWorkflow],
  budgets: TEST_BUDGETS,
})
export class SpendApplication {}

/** The same with its own execution budget of $0.001: one paid search spends it. */
@Workflow({ name: "tight-spend-workflow", version: "1.0.0", providers: [ShipAction], flow: paths })
export class TightSpendWorkflow {}

@Budget({
  name: "tight-spend-execution-budget",
  scope: BudgetScope.Execution,
  workflow: TightSpendWorkflow,
})
export class TightSpendExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.001);
  }
}

@Application({
  name: "tight-spend-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TightSpendWorkflow],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, TightSpendExecutionBudget],
})
export class TightSpendApplication {}
