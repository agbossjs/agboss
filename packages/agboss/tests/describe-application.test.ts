/**
 * #261 PR 6 — `agboss describe` on a workflow of an application: each contract's implementation and
 * why, the budgets by scope with their periods, the execution budget that caps the workflow (its
 * own or the default), the observers, the assembly warnings and the count limits.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../src/application/application.js";
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "../src/budgets/budget.js";
import { describedApplicationOf } from "../src/describe/application.js";
import { describedLimitsOf } from "../src/describe/limits.js";
import { describeWorkflow } from "../src/describe/describe-workflow.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnExecutionEnd,
} from "../src/index.js";
import { ImplementationReason } from "../src/application/implementations.js";
import { workflowOf } from "../src/testing/index.js";
import { usd, type Usd } from "../src/units/index.js";
import { start } from "./helpers/flow.js";
import { RecordingCostLedgerRepository } from "./application/fixtures/desks.application.js";

@Agent({
  name: "teller-agent",
  description: "Tells",
  prompt: "Tell.",
  model: "test/teller",
  maxVisits: 2,
})
class TellerAgent {}

@WorkflowStart({ name: "tell-workflow-start", description: "Ask", input: WorkflowStartTextDto })
class TellWorkflowStart {}

@WorkflowFinish({
  name: "told-workflow-finish",
  description: "Told",
  output: WorkflowFinishTextDto,
})
class ToldWorkflowFinish {}

@Workflow({
  name: "tell-workflow",
  version: "1.0.0",
  maxSteps: 2,
  defaults: { models: { temperature: 0 }, history: { limit: 1 } },
  flow: [
    start(TellWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(TellerAgent)
      .toFinish(ToldWorkflowFinish),
  ],
})
class TellWorkflow {}

@Budget({
  name: "tell-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
class TellApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}

@Budget({ name: "tell-tenant-weekly-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Week })
class TellTenantWeeklyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(5);
  }
}

@Budget({ name: "tell-default-execution-budget", scope: BudgetScope.Execution })
class TellDefaultExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "tell-execution-budget", scope: BudgetScope.Execution, workflow: TellWorkflow })
class TellExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.5);
  }
}

@Injectable()
class TellAuditObserver implements OnExecutionEnd {
  onExecutionEnd(): void {
    // audited
  }
}

@Application({
  name: "tell-application",
  version: "4.0.0",
  environment: EmptyEnvironment,
  workflows: [TellWorkflow],
  providers: [RecordingCostLedgerRepository],
  observers: [TellAuditObserver],
  budgets: [
    TellApplicationBudget,
    TellTenantWeeklyBudget,
    TellDefaultExecutionBudget,
    TellExecutionBudget,
  ],
})
export class TellApplication {}

const tell = await workflowOf(TellWorkflow);

describe("#261 M1: describe shows the application", () => {
  it("each contract's implementation and why: listed, else the built-in default", () => {
    const described = describedApplicationOf(tell);

    expect(
      described?.implementations.map((choice) => [
        choice.contract.name,
        choice.implementation.name,
        choice.reason,
      ]),
    ).toContainEqual([
      "CostLedgerRepository",
      "RecordingCostLedgerRepository",
      ImplementationReason.Listed,
    ]);
    expect(describeWorkflow(tell)).toContain(
      "  CostLedgerRepository → RecordingCostLedgerRepository (listed in @Application providers)",
    );
    expect(describeWorkflow(tell)).toContain(
      "  Logger → ConsoleLogger (built-in default: none listed)",
    );
  });

  it("the budgets by scope with their periods, and the workflow's own execution budget", () => {
    const lines = describeWorkflow(tell);
    const at = lines.indexOf("budgets");

    expect(lines.slice(at, at + 5)).toEqual([
      "budgets",
      "  application: tell-application-budget (day)",
      "  tenant: tell-tenant-weekly-budget (week)",
      "  execution: tell-default-execution-budget (default), tell-execution-budget (tell-workflow)",
      "  tell-workflow: tell-execution-budget (its own) — applies when it is the root of app.execute; nested, it spends from its root's",
    ]);
    expect(describedApplicationOf(tell)?.executionBudget).toEqual({
      name: "tell-execution-budget",
      isOwn: true,
    });
  });

  it("the observers and the warnings (a durable ledger listed, no pause: only the PII key's)", () => {
    const lines = describeWorkflow(tell);

    expect(lines).toContain("observers TellAuditObserver");
    expect(describedApplicationOf(tell)?.warnings).toEqual([
      "[application.pii-instance-key] no @Application({ pseudonymKey }): sensitive fields and policies without their own key make PII tokens with a key of this instance — one value gets another token on each instance, so logs and traces compare across instances only with pseudonymKey",
    ]);
    expect(lines.filter((line) => line.startsWith("warning ")).length).toBeLessThanOrEqual(1);
  });

  it("the count limits: maxSteps as set, each node's maxVisits, the worst case of each start", () => {
    expect(describedLimitsOf(tell)).toMatchObject({
      maxSteps: 2,
      isMaxStepsSet: true,
      maxVisits: { "teller-agent": 2 },
    });
    const lines = describeWorkflow(tell);
    const at = lines.indexOf("limits");
    expect(lines.slice(at, at + 4)).toEqual([
      "limits",
      "  maxSteps 2 (set) · steps 1–1",
      "  maxVisits teller-agent 2",
      "  Worst case of one tell-workflow-start call: 1 workflow execution, 1 at the same time, 1 agent and router steps",
    ]);
  });
});
