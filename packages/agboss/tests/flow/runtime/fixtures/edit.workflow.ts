import { Text, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  Router,
  VisitsLimitExceededError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Action,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { optional } from "../../../../src/flow/dto-wrappers.js";
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "../../../../src/index.js";
import { usd, type Usd } from "../../../../src/units/index.js";
import { onAgent, onStart, toFinish, toAction, toAgent } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS, TestApplicationDailyBudget } from "../../fixtures/budgets.js";
import { EmptyEnvironment } from "../../../../src/index.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";
import { TestDecisionsModelProvider } from "../../../../src/testing/test-model-provider.js";

/** The editor's draft: each visit replaces the one before in the path scope. */
export class DraftDto {
  @Text({ prompt: "the draft" })
  text!: string;
}

@WorkflowStart({
  name: "edit-workflow-start",
  description: "What to write",
  input: WorkflowStartTextDto,
})
export class EditStart {}

const editor = {
  description: "Writes the draft, again after the gate's review",
  prompt: inline("Write the draft."),
  model: "test/editor",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
  executionLimits: { maxVisits: 2 },
  input: { message: WorkflowStartTextDto, draft: optional(DraftDto) },
  output: DraftDto,
} as const;

/** At most two drafts; a third visit is refused before its model call (#272 AC14). */
@Agent({ name: "editor-agent", ...editor })
export class EditorAgent {}

@WorkflowFinish({ name: "done-workflow-finish", description: "The draft", output: DraftDto })
export class DoneFinish {}

/** The last draft, if any: on the side path of a first visit there is none yet. */
@Action({
  name: "gave-up-action",
  description: "The last draft, the editor's visits spent",
  input: { draft: optional(DraftDto) },
  output: DraftDto,
})
export class GaveUpAction {
  async execute(input: { readonly draft?: DraftDto }): Promise<DraftDto> {
    return input.draft ?? { text: "" };
  }
}

@WorkflowFinish({
  name: "gave-up-workflow-finish",
  description: "The last draft, the editor's visits spent",
  output: DraftDto,
})
export class GaveUpFinish {}

@Router({
  name: "gate-router",
  description: "Sends the draft back or accepts it",
  decidedBy: DecidedBy.Model,
  prompt: inline("Is the draft good?"),
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  input: { draft: DraftDto },
  maxVisits: 5,
  routes: [
    { prompt: "The draft needs another pass", target: EditorAgent },
    { prompt: "Stop and send the draft: it is good", target: DoneFinish },
  ],
})
export class GateRouter {}

/** edit → editor ⇄ gate → done; the editor's third visit fails the execution. */
@Workflow({
  name: "edit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(EditStart)
      .toAgent(EditorAgent),
    onAgent(EditorAgent)
      .toRouter(GateRouter)
      .onRoute(toAgent(EditorAgent))
      .onRoute(toFinish(DoneFinish)),
  ],
})
export class EditWorkflow {}

@Application({
  name: "edit-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EditWorkflow],
  budgets: TEST_BUDGETS,
})
export class EditApplication {}

@Agent({ name: "patient-editor-agent", ...editor })
export class PatientEditorAgent {}

@Router({
  name: "patient-gate-router",
  description: "Sends the draft back or accepts it",
  decidedBy: DecidedBy.Model,
  prompt: inline("Is the draft good?"),
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  input: { draft: DraftDto },
  maxVisits: 5,
  routes: [
    { prompt: "The draft needs another pass", target: PatientEditorAgent },
    { prompt: "Stop and send the draft: it is good", target: DoneFinish },
  ],
})
export class PatientGateRouter {}

/** The same loop, the refused visit caught: `.onError(VisitsLimitExceededError, toFinish(…))`. */
@Workflow({
  name: "patient-edit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(EditStart)
      .toAgent(PatientEditorAgent),
    onAgent(PatientEditorAgent)
      .onError(
        VisitsLimitExceededError,
        toAction(GaveUpAction)
          .toFinish(GaveUpFinish),
      )
      .toRouter(PatientGateRouter)
      .onRoute(toAgent(PatientEditorAgent))
      .onRoute(toFinish(DoneFinish)),
  ],
})
export class PatientEditWorkflow {}

@Application({
  name: "patient-edit-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PatientEditWorkflow],
  budgets: TEST_BUDGETS,
})
export class PatientEditApplication {}

const editPaths = [
  onStart(EditStart)
    .toAgent(EditorAgent),
  onAgent(EditorAgent)
    .toRouter(GateRouter)
    .onRoute(toAgent(EditorAgent))
    .onRoute(toFinish(DoneFinish)),
];

/** The loop with 3 steps per execution (`@Workflow({ executionLimits: { maxSteps } })`). */
@Workflow({
  name: "short-edit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 3 },
  flow: editPaths,
})
export class ShortEditWorkflow {}

@Application({
  name: "short-edit-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ShortEditWorkflow],
  budgets: TEST_BUDGETS,
})
export class ShortEditApplication {}

/** The loop with its own execution budget of $0.015 and a tenant budget of $0.02 a day. */
@Workflow({
  name: "cheap-edit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: editPaths,
})
export class CheapEditWorkflow {}

@Budget({
  name: "cheap-edit-execution-budget",
  scope: BudgetScope.Execution,
  workflow: CheapEditWorkflow,
})
export class CheapEditExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.015);
  }
}

@Budget({ name: "cheap-tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class CheapTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.02);
  }
}

@Application({
  name: "cheap-edit-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CheapEditWorkflow],
  budgets: [TestApplicationDailyBudget, CheapTenantDailyBudget, CheapEditExecutionBudget],
})
export class CheapEditApplication {}
