import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  ExecutionContext,
  Injectable,
  Observer,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  type ExecutionEndEvent,
  type ExecutionCancelEvent,
  type ExecutionErrorEvent,
  inline,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import {
  CostLedgerRepository,
  InMemoryCostLedgerRepository,
  type BudgetAccount,
  type CostCounter,
  type LedgerEntry,
  type BudgetLimit,
  type BudgetUsage,
} from "../../../src/infrastructure/cost-ledger.repository.js";
import type { CostReport } from "../../../src/finops/usage.js";
import type { Usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toAgent } from "../../helpers/flow.js";

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
  /** How many roots ended failed or cancelled (#875). */
  failures: 0,
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
  lostPassSeen.failures = 0;
  lostPassSeen.holds = 0;
  lostPassSeen.modelCalls = 0;
  lostPassLevers.isHolding = false;
  delete lostPassLevers.letGo;
  shared = new InMemoryCostLedgerRepository();
}

/** What the shared ledger holds for `counter`. */
export const sharedSpentOf = (counter: CostCounter): Promise<Usd> =>
  shared.findUsageByCounter(counter).then((usage) => usage.spent);

/** One ledger for every instance of a test, keeping what it was handed. */
@Injectable()
export class SharedCostLedgerRepository extends CostLedgerRepository {
  ping(): Promise<void> {
    return shared.ping();
  }
  findUsageByCounter(counter: CostCounter): Promise<BudgetUsage> {
    return shared.findUsageByCounter(counter);
  }
  saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    lostPassSeen.saved.push(...entries);
    return shared.saveAll(counters, entries);
  }
  deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    return shared.deleteByMadeAtBefore(cutoff);
  }
  findLimitByAccount(account: BudgetAccount): Promise<BudgetLimit | undefined> {
    return shared.findLimitByAccount(account);
  }
  saveLimit(account: BudgetAccount, limit: BudgetLimit): Promise<void> {
    return shared.saveLimit(account, limit);
  }
}

/** Keeps each root's spend report at its end, counts its failures, and counts the model calls that started. */
@Observer()
export class SpendLog {
  onModelStart(): void {
    lostPassSeen.modelCalls += 1;
  }
  onExecutionEnd(event: ExecutionEndEvent): void {
    if (event.parentExecutionId === undefined) lostPassSeen.ends.push(event.spend);
  }
  onExecutionError(event: ExecutionErrorEvent): void {
    if (event.parentExecutionId === undefined) lostPassSeen.failures += 1;
  }
  /** A root's cancel (#1341) ends it as a failure did: it is counted with them. */
  onExecutionCancel(event: ExecutionCancelEvent): void {
    if (event.parentExecutionId === undefined) lostPassSeen.failures += 1;
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
  prompt: inline("Write the report."),
  model: "test/writer",
  input: { message: WorkflowStartTextDto },
  output: ReportDto,
})
export class WriterAgent {}

/** Reviews the report: a model step after the one that may be lost. */
@Agent({
  name: "reviewer-agent",
  description: "Reviews the report",
  prompt: inline("Review the report."),
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

  async execute(input: { readonly report: Tracked<ReportDto> }): Promise<ReportDto> {
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
    return input.report;
  }
}

@Workflow({
  name: "lost-pass-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 } },
  flow: [
    onStart(LostPassWorkflowStart)
      .toAgent(WriterAgent)
      .toAgent(ReviewerAgent)
      .toAction(HoldReportAction)
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
  prompt: inline("Check the task."),
  model: "test/checker",
  input: { message: WorkflowStartTextDto },
  output: CheckDto,
})
export class CheckerAgent {}

@Agent({
  name: "drafter-agent",
  description: "Drafts the report",
  prompt: inline("Draft the report."),
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
    readonly report: Tracked<ReportDto>;
    readonly check: Tracked<CheckDto>;
  }): Promise<ReportDto> {
    return Promise.resolve({ text: `${input.report.text}: ${input.check.verdict}` });
  }
}

/** Two agents in one superstep: the drafter answers at once, the checker's call may be lost. */
@Workflow({
  name: "lost-branch-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 } },
  flow: [
    onStart(LostBranchWorkflowStart)
      .inParallel([toAgent(DrafterAgent), toAgent(CheckerAgent)])
      .join()
      .toAction(MergeReportAction)
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
