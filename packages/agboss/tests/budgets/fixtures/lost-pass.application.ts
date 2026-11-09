import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  ExecutionContext,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
  type ExecutionEndEvent,
  type OnExecutionEnd,
  type OnModelStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import {
  CostLedgerRepository,
  InMemoryCostLedgerRepository,
  type BudgetAccount,
  type CostCounter,
  type LedgerEntry,
} from "../../../src/infrastructure/cost-ledger.repository.js";
import type { CostReport } from "../../../src/finops/usage.js";
import type { Usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/**
 * #853 — a step whose pass is lost mid model call: one agent (its model scripted, the first call
 * waiting long past the lease), then an action that can hold the tree after the agent finished.
 * The instances share one ledger, which keeps every entry it was handed; an observer keeps each
 * root's spend report at its end.
 */

/** What the test saw (reset with `resetLostPass`). */
export const lostPassSeen = {
  /** Every entry any instance handed the ledger, in order (a repeated id is one entry there). */
  saved: [] as LedgerEntry[],
  /** Each root's spend report at its end. */
  ends: [] as CostReport[],
  holds: 0,
  /** How many model calls started, on every instance. */
  modelCalls: 0,
};

/** The hold's lever: the first hold waits until the test lets it go. */
export const lostPassLevers: { isHolding: boolean; letGo?: () => void } = { isHolding: false };

let shared = new InMemoryCostLedgerRepository();

export function resetLostPass(): void {
  lostPassSeen.saved.length = 0;
  lostPassSeen.ends.length = 0;
  lostPassSeen.holds = 0;
  lostPassSeen.modelCalls = 0;
  lostPassLevers.isHolding = false;
  delete lostPassLevers.letGo;
  shared = new InMemoryCostLedgerRepository();
}

/** What the shared ledger holds for `counter`. */
export const sharedSpentOf = (counter: CostCounter): Promise<Usd> =>
  shared.findSpentByCounter(counter);

/** One ledger for every instance of a test, keeping what it was handed. */
@Injectable()
export class SharedCostLedgerRepository extends CostLedgerRepository {
  ping(): Promise<void> {
    return shared.ping();
  }
  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    return shared.findSpentByCounter(counter);
  }
  saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    lostPassSeen.saved.push(...entries);
    return shared.saveAll(counters, entries);
  }
  deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    return shared.deleteByMadeAtBefore(cutoff);
  }
  findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined> {
    return shared.findMaxSpendByAccount(account);
  }
  saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void> {
    return shared.saveMaxSpend(account, maxSpend);
  }
}

/** Keeps each root's spend report at its end, and counts the model calls that started. */
@Injectable()
export class SpendLog implements OnExecutionEnd, OnModelStart {
  onModelStart(): void {
    lostPassSeen.modelCalls += 1;
  }
  onExecutionEnd(event: ExecutionEndEvent): void {
    if (event.parentExecutionId === undefined) lostPassSeen.ends.push(event.spend);
  }
}

export class ReportDto {
  @Text({ prompt: "the report" })
  text!: string;
}

@WorkflowStart({
  name: "lost-pass-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class LostPassWorkflowStart {}

@WorkflowFinish({ name: "lost-pass-workflow-finish", description: "The report", output: ReportDto })
export class LostPassWorkflowFinish {}

@Agent({
  name: "writer-agent",
  description: "Writes the report",
  prompt: "Write the report.",
  model: "test/writer",
  input: { message: WorkflowStartTextDto },
  output: ReportDto,
})
export class WriterAgent {}

/** Reviews the report: a model step after the one that may be lost. */
@Agent({
  name: "reviewer-agent",
  description: "Reviews the report",
  prompt: "Review the report.",
  model: "test/reviewer",
  input: { report: ReportDto },
  output: ReportDto,
})
export class ReviewerAgent {}

/** Holds the tree after the agent: the first hold waits until the test lets it go. */
@Action({
  name: "hold-report-action",
  description: "Holds the report",
  input: { report: ReportDto },
  output: ReportDto,
  deps: [ExecutionContext],
})
export class HoldReportAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: { readonly report: Produced<ReportDto, unknown> }): Promise<ReportDto> {
    lostPassSeen.holds += 1;
    if (lostPassLevers.isHolding) {
      lostPassLevers.isHolding = false;
      const { signal } = this.executionContext;
      await new Promise<void>((resolve) => {
        lostPassLevers.letGo = resolve;
        signal.addEventListener("abort", () => {
          resolve();
        });
      });
    }
    return input.report.value;
  }
}

@Workflow({
  name: "lost-pass-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 } },
  flow: [
    start(LostPassWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(WriterAgent)
      .returns(ReportDto)
      .toAgent(ReviewerAgent)
      .returns(ReportDto)
      .toAction(HoldReportAction)
      .returns(ReportDto)
      .toFinish(LostPassWorkflowFinish),
  ],
})
export class LostPassWorkflow {}

export class CheckDto {
  @Text({ prompt: "the check" })
  verdict!: string;
}

@WorkflowStart({
  name: "lost-branch-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class LostBranchWorkflowStart {}

@WorkflowFinish({
  name: "lost-branch-workflow-finish",
  description: "The report",
  output: ReportDto,
})
export class LostBranchWorkflowFinish {}

@Agent({
  name: "checker-agent",
  description: "Checks the task",
  prompt: "Check the task.",
  model: "test/checker",
  input: { message: WorkflowStartTextDto },
  output: CheckDto,
})
export class CheckerAgent {}

@Agent({
  name: "drafter-agent",
  description: "Drafts the report",
  prompt: "Draft the report.",
  model: "test/drafter",
  input: { message: WorkflowStartTextDto },
  output: ReportDto,
})
export class DrafterAgent {}

/** Puts the draft and the check together (code: no model). */
@Action({
  name: "merge-report-action",
  description: "Merges the draft and the check",
  input: { report: ReportDto, check: CheckDto },
  output: ReportDto,
})
export class MergeReportAction {
  execute(input: {
    readonly report: Produced<ReportDto, unknown>;
    readonly check: Produced<CheckDto, unknown>;
  }): Promise<ReportDto> {
    return Promise.resolve({ text: `${input.report.value.text}: ${input.check.value.verdict}` });
  }
}

/** Two agents in one superstep: the drafter answers at once, the checker's call may be lost. */
@Workflow({
  name: "lost-branch-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 } },
  flow: [
    start(LostBranchWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toParallelAgents(DrafterAgent, CheckerAgent)
      .join()
      .returns(ReportDto)
      .returns(CheckDto)
      .toAction(MergeReportAction)
      .returns(ReportDto)
      .toFinish(LostBranchWorkflowFinish),
  ],
})
export class LostBranchWorkflow {}

@Application({
  name: "lost-pass-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LostPassWorkflow, LostBranchWorkflow],
  observers: [SpendLog],
  providers: [SharedCostLedgerRepository],
  budgets: TEST_BUDGETS,
})
export class LostPassApplication {}
